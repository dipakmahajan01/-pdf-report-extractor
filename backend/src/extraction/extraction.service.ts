import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionMethod, ExtractionStage } from '../database/enums.js';
import { OCR_PROVIDER, type OcrProvider } from './ocr/ocr-provider.js';
import { buildLines } from './parsing/line-builder.js';
import { parseMetadata } from './parsing/metadata-parser.js';
import { parseTable, type TableParseResult } from './parsing/table-parser.js';
import { extractPageWords, loadPdf, renderPage, type PdfDocument } from './pdf/pdf-reader.js';
import { ExtractionError, type ExtractionResult, type ExtractionWarning, type PageContent } from './types.js';

/** A page with fewer characters than this in its text layer is treated as scanned. */
const TEXT_PAGE_MIN_CHARS = 20;
/** Average OCR confidence below this triggers one retry with stronger image cleanup. */
const OCR_RETRY_CONFIDENCE = 75;
const OCR_RETRY_DPI = 300;
/** Average OCR confidence below this (after the retry) fails the extraction instead of saving guesses. */
const OCR_MIN_CONFIDENCE = 70;
/** Tesseract page segmentation modes: 6 = one uniform block, 4 = one column of variable-size text. */
const PSM_FIRST = 6;
const PSM_RETRY = 4;

interface Pass {
  pages: PageContent[];
  table: TableParseResult;
  ocrConfidence?: number;
}

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly ocrDpi: number;

  constructor(
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
    config: ConfigService,
  ) {
    this.ocrDpi = Number(config.get('OCR_DPI') ?? 300);
  }

  /**
   * Reads a PDF and returns its report details and table rows.
   * Throws ExtractionError (with the failed stage) when nothing usable can be read.
   */
  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const { doc, close } = await loadPdf(buffer);
    try {
      return await this.extractFromDocument(doc);
    } finally {
      await close();
    }
  }

  private async extractFromDocument(doc: PdfDocument): Promise<ExtractionResult> {
    const warnings: ExtractionWarning[] = [];

    // 1. Text layer per page; remember which pages are scanned images.
    const textPages = new Map<number, PageContent>();
    const scannedPages: number[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const words = await this.stage(ExtractionStage.TextExtract, () => extractPageWords(doc, p));
      const chars = words.reduce((n, w) => n + w.text.length, 0);
      if (chars >= TEXT_PAGE_MIN_CHARS) textPages.set(p, { page: p, source: 'text', lines: buildLines(words, p) });
      else scannedPages.push(p);
    }
    const method =
      scannedPages.length === 0
        ? ExtractionMethod.Text
        : scannedPages.length === doc.numPages
          ? ExtractionMethod.Ocr
          : ExtractionMethod.Mixed;

    // 2. OCR for scanned pages, with one retry if the first pass is weak.
    let pass = await this.runPass(doc, textPages, scannedPages, { dpi: this.ocrDpi, psm: PSM_FIRST, binarize: false });
    if (scannedPages.length && (pass.table.rows.length === 0 || (pass.ocrConfidence ?? 100) < OCR_RETRY_CONFIDENCE)) {
      this.logger.log(`OCR retry (confidence ${pass.ocrConfidence?.toFixed(0)}%, ${pass.table.rows.length} rows)`);
      const retry = await this.runPass(doc, textPages, scannedPages, { dpi: OCR_RETRY_DPI, psm: PSM_RETRY, binarize: true });
      warnings.push({ code: 'OCR_RETRIED', message: 'The scan was hard to read, so OCR was run a second time.' });
      if (retry.table.score > pass.table.score || (retry.table.score === pass.table.score && retry.table.rows.length > pass.table.rows.length)) {
        pass = retry;
      }
    }

    const { pages, table, ocrConfidence } = pass;

    // Below this confidence OCR output is mostly guesses; failing is safer than storing wrong lab values.
    if (ocrConfidence !== undefined && ocrConfidence < OCR_MIN_CONFIDENCE) {
      throw new ExtractionError(
        'OCR_LOW_CONFIDENCE',
        ExtractionStage.Ocr,
        `The scan quality is too low to read reliably (OCR confidence ${Math.round(ocrConfidence)}%, minimum ${OCR_MIN_CONFIDENCE}%). Please upload a clearer scan.`,
        true,
        method,
      );
    }
    const rawText = pages
      .map((p) => `--- page ${p.page} (${p.source}) ---\n${p.lines.map((l) => l.text).join('\n')}`)
      .join('\n\n');

    if (!table.rows.some((r) => !r.isSection)) {
      const isScanned = method !== ExtractionMethod.Text;
      throw new ExtractionError(
        isScanned ? 'OCR_NO_TABLE' : 'NO_PARAMETERS_FOUND',
        ExtractionStage.Parse,
        isScanned
          ? `Could not read a results table from the scanned PDF (OCR confidence ${Math.round(ocrConfidence ?? 0)}%). The image quality may be too low.`
          : 'No test results table was found in this PDF.',
        true,
        method,
      );
    }

    // 3. Report details come from the lines above the table on the first page.
    const firstPage = pages[0];
    const headerLines =
      table.headerLineIndex !== undefined ? firstPage.lines.slice(0, table.headerLineIndex) : firstPage.lines.slice(0, 25);
    const metadata = parseMetadata(headerLines);

    if (method !== ExtractionMethod.Text) {
      warnings.push({
        code: 'OCR_USED',
        message: `Scanned pages were read with OCR (average confidence ${Math.round(ocrConfidence ?? 0)}%). Please verify the values.`,
      });
    }
    const pagesWithRows = new Set(table.rows.map((r) => r.page));
    if (pagesWithRows.size > 1) {
      warnings.push({ code: 'MULTI_PAGE_TABLE', message: `The results table spans ${pagesWithRows.size} pages.` });
    }
    for (const message of table.warnings) warnings.push({ code: 'INVALID_RANGE', message });

    return {
      pageCount: doc.numPages,
      method,
      metadata,
      rows: table.rows,
      score: Math.round(table.score * 1000) / 1000,
      ocrConfidence,
      rawText,
      warnings,
    };
  }

  private async runPass(
    doc: PdfDocument,
    textPages: Map<number, PageContent>,
    scannedPages: number[],
    opts: { dpi: number; psm: number; binarize: boolean },
  ): Promise<Pass> {
    const ocrPages: PageContent[] = [];
    for (const p of scannedPages) {
      const result = await this.stage(ExtractionStage.Ocr, async () => {
        const png = await renderPage(doc, p, { dpi: opts.dpi, binarize: opts.binarize });
        return this.ocr.recognize(png, { dpi: opts.dpi, page: p, psm: opts.psm });
      });
      ocrPages.push({ page: p, source: 'ocr', lines: result.lines, ocrConfidence: result.confidence });
    }
    const pages = [...textPages.values(), ...ocrPages].sort((a, b) => a.page - b.page);
    const table = await this.stage(ExtractionStage.Parse, async () => parseTable(pages));
    const ocrConfidence = ocrPages.length
      ? ocrPages.reduce((sum, p) => sum + (p.ocrConfidence ?? 0), 0) / ocrPages.length
      : undefined;
    return { pages, table, ocrConfidence };
  }

  /** Runs one step and tags unexpected errors with the stage they came from. */
  private async stage<T>(stage: ExtractionStage, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      this.logger.error(`Extraction failed at stage "${stage}"`, (error as Error).stack);
      throw new ExtractionError('EXTRACTION_ERROR', stage, `Unexpected error while processing the PDF (${stage}).`, true);
    }
  }
}

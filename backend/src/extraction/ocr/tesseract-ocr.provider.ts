import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import type { Line, Word } from '../types.js';
import type { OcrProvider, OcrResult } from './ocr-provider.js';

/** Words below this confidence are treated as noise (dust, table lines). */
const MIN_WORD_CONFIDENCE = 30;

// The English LSTM model ships inside node_modules, so OCR works offline.
const LANG_PATH = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json')),
  '4.0.0_best_int',
);

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

@Injectable()
export class TesseractOcrProvider implements OcrProvider, OnModuleDestroy {
  private readonly logger = new Logger(TesseractOcrProvider.name);
  private worker?: Promise<Worker>;

  /** One worker, created on first use and reused (creating it loads the model, about 1 s). */
  private getWorker(): Promise<Worker> {
    this.worker ??= createWorker('eng', OEM.LSTM_ONLY, { langPath: LANG_PATH, cacheMethod: 'none' }).then((w) => {
      this.logger.log('Tesseract worker ready');
      return w;
    });
    return this.worker;
  }

  async recognize(png: Buffer, { dpi, page, psm }: { dpi: number; page: number; psm: number }): Promise<OcrResult> {
    const worker = await this.getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: String(psm) as never, preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(png, {}, { blocks: true });

    const toPoints = 72 / dpi;
    const lines: Line[] = [];
    let confidenceSum = 0;
    let wordCount = 0;

    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const ocrLine of paragraph.lines) {
          const words: Word[] = (ocrLine.words as TesseractWord[])
            .filter((w) => w.text.trim() && w.confidence >= MIN_WORD_CONFIDENCE)
            .map((w) => ({
              text: w.text.trim(),
              x: w.bbox.x0 * toPoints,
              y: w.bbox.y0 * toPoints,
              width: (w.bbox.x1 - w.bbox.x0) * toPoints,
              height: (w.bbox.y1 - w.bbox.y0) * toPoints,
              confidence: w.confidence,
            }))
            .sort((a, b) => a.x - b.x);
          if (!words.length) continue;
          for (const w of words) {
            confidenceSum += w.confidence ?? 0;
            wordCount++;
          }
          lines.push({
            page,
            y: words.reduce((sum, w) => sum + w.y, 0) / words.length,
            words,
            text: words.map((w) => w.text).join(' '),
          });
        }
      }
    }
    lines.sort((a, b) => a.y - b.y);
    return { lines, confidence: wordCount ? confidenceSum / wordCount : 0 };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await (await this.worker).terminate();
  }
}

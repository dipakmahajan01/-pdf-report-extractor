import { HttpStatus, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, In, QueryFailedError, type Repository } from 'typeorm';
import { AppException } from '../common/app.exception.js';
import { Document } from '../database/entities/document.entity.js';
import { ExtractionAttempt } from '../database/entities/extraction-attempt.entity.js';
import { ReportParameter } from '../database/entities/report-parameter.entity.js';
import { Report } from '../database/entities/report.entity.js';
import { AttemptStatus, DocumentStatus, ExtractionStage } from '../database/enums.js';
import { ExtractionService } from '../extraction/extraction.service.js';
import { ExtractionError, type ExtractionResult } from '../extraction/types.js';
import { toDocumentDetail, toDocumentSummary, type DocumentDetail, type DocumentSummary } from './documents.mapper.js';
import { MAX_ATTEMPTS } from './documents.constants.js';
import { FileStorageService } from './file-storage.service.js';

/** Parse score below this, or OCR below this confidence, saves the report as "needs_review". */
const REVIEW_SCORE = 0.7;
const REVIEW_OCR_CONFIDENCE = 85;
/** A document still "processing" after this long was interrupted (e.g. server restart). */
const STALE_PROCESSING_MINUTES = 10;

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(ReportParameter) private readonly parameters: Repository<ReportParameter>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly extraction: ExtractionService,
    private readonly storage: FileStorageService,
  ) {}

  /** Documents left in "processing" by a crash or restart become failed (and retryable). */
  async onApplicationBootstrap(): Promise<void> {
    const cutoff = `now() - interval '${STALE_PROCESSING_MINUTES} minutes'`;
    await this.dataSource.query(
      `UPDATE extraction_attempts SET status = 'failed', error_code = 'INTERRUPTED', finished_at = now(),
         error_message = 'Processing was interrupted (server restart).'
       WHERE status = 'running' AND started_at < ${cutoff}`,
    );
    const [, count] = await this.dataSource.query(
      `UPDATE documents SET status = 'failed', last_error_code = 'INTERRUPTED', is_retryable = true,
         last_error_message = 'Processing was interrupted (server restart). Please retry.', updated_at = now()
       WHERE status = 'processing' AND updated_at < ${cutoff}`,
    );
    if (count) this.logger.warn(`Marked ${count} interrupted document(s) as failed`);
  }

  // ---------------------------------------------------------------------------
  // Upload and retry
  // ---------------------------------------------------------------------------

  async upload(file: Express.Multer.File): Promise<DocumentDetail> {
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.documents.findOneBy({ fileHash });
    if (existing) throw this.duplicateFile(existing);

    // The file and the document row are saved before extraction, so any later failure can be retried.
    const filePath = await this.storage.save(fileHash, file.buffer);
    let document: Document;
    try {
      document = await this.documents.save(
        this.documents.create({
          fileName: file.originalname.slice(0, 255),
          filePath,
          fileHash,
          fileSizeBytes: file.size,
          status: DocumentStatus.Processing,
          attemptCount: 1,
        }),
      );
    } catch (error) {
      // Same file uploaded twice at the same moment: the UNIQUE constraint decides.
      if (isUniqueViolation(error)) {
        const winner = await this.documents.findOneByOrFail({ fileHash });
        throw this.duplicateFile(winner);
      }
      throw error;
    }

    return this.runAttempt(document, 1, file.buffer);
  }

  async retry(id: string): Promise<DocumentDetail> {
    const document = await this.findDocument(id);
    if (!document.isRetryable) {
      throw new AppException(
        'NOT_RETRYABLE',
        `This document cannot be retried: ${document.lastErrorMessage ?? 'the file itself is invalid.'}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (document.attemptCount >= MAX_ATTEMPTS) {
      throw new AppException(
        'MAX_ATTEMPTS_REACHED',
        `This document was already tried ${document.attemptCount} times (maximum ${MAX_ATTEMPTS}).`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Claim the document atomically, so two retry clicks cannot run at the same time.
    const [rows] = await this.dataSource.query(
      `UPDATE documents SET status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1 AND status <> 'processing' AND attempt_count < $2
       RETURNING attempt_count`,
      [id, MAX_ATTEMPTS],
    );
    if (!rows?.length) {
      throw new AppException('ALREADY_PROCESSING', 'This document is already being processed.', HttpStatus.CONFLICT);
    }

    const buffer = await this.storage.read(document.filePath);
    return this.runAttempt(document, rows[0].attempt_count as number, buffer);
  }

  /** One full extraction run, recorded in extraction_attempts whatever the outcome. */
  private async runAttempt(document: Document, attemptNo: number, buffer: Buffer): Promise<DocumentDetail> {
    const attempts = this.dataSource.getRepository(ExtractionAttempt);
    const attempt = await attempts.save(attempts.create({ documentFk: document.id, attemptNo }));
    const started = Date.now();

    let result: ExtractionResult;
    try {
      result = await this.extraction.extract(buffer);
    } catch (error) {
      const failure =
        error instanceof ExtractionError
          ? error
          : new ExtractionError('EXTRACTION_ERROR', ExtractionStage.Parse, 'Unexpected error while reading the PDF.', true);
      if (!(error instanceof ExtractionError)) this.logger.error('Extraction crashed', (error as Error).stack);
      await this.markFailed(document.id, attempt.id, failure, Date.now() - started);
      throw this.extractionFailed(document.id, failure);
    }

    const { reportId, idAutoGenerated } = resolveReportId(result.metadata.reportId, document.fileHash);
    const warnings = [...result.warnings];
    if (idAutoGenerated) {
      warnings.unshift({
        code: 'ID_AUTO_GENERATED',
        message: `No Report/Sample ID was found in the PDF, so "${reportId}" was generated.`,
      });
    }
    const needsReview =
      result.score < REVIEW_SCORE || (result.ocrConfidence !== undefined && result.ocrConfidence < REVIEW_OCR_CONFIDENCE);
    if (needsReview) {
      warnings.push({ code: 'NEEDS_REVIEW', message: 'Some values may not have been read correctly. Please check them against the PDF.' });
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        // A retry replaces the previous report (its parameters are removed by ON DELETE CASCADE).
        await manager.delete(Report, { documentFk: document.id });
        const report = await manager.save(
          manager.create(Report, {
            documentFk: document.id,
            reportId,
            idAutoGenerated,
            patientName: result.metadata.patientName ?? null,
            reportDate: result.metadata.reportDate ?? null,
            labName: result.metadata.labName ?? 'UNKNOWN',
            pageCount: result.pageCount,
            extractionMethod: result.method,
            parseScore: result.score,
            warnings,
            rawText: result.rawText,
          }),
        );
        await manager.insert(
          ReportParameter,
          result.rows.map((row, index) => ({
            reportFk: report.id,
            rowOrder: index,
            pageNumber: row.page,
            isSection: row.isSection,
            sectionName: row.sectionName ?? null,
            name: row.name,
            nameNormalized: row.nameNormalized,
            valueRaw: row.valueRaw ?? null,
            valueNumeric: row.valueNumeric ?? null,
            comparator: row.comparator ?? null,
            unit: row.unit ?? null,
            refRangeRaw: row.refRangeRaw ?? null,
            refLow: row.refLow ?? null,
            refHigh: row.refHigh ?? null,
            flag: row.flag ?? null,
            ocrConfidence: row.ocrConfidence ?? null,
            extra: row.extra ?? null,
          })),
        );
        await manager.update(ExtractionAttempt, attempt.id, {
          status: AttemptStatus.Success,
          extractionMethod: result.method,
          rowsFound: result.rows.filter((r) => !r.isSection).length,
          parseScore: result.score,
          durationMs: Date.now() - started,
          finishedAt: new Date(),
        });
        await manager.update(Document, document.id, {
          status: needsReview ? DocumentStatus.NeedsReview : DocumentStatus.Completed,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A different file with the same lab + Report ID: a duplicate report, nothing to retry.
        await this.removeDocument(document);
        throw new AppException(
          'DUPLICATE_REPORT_ID',
          `A report with ID "${reportId}" from "${result.metadata.labName ?? 'UNKNOWN'}" already exists.`,
          HttpStatus.CONFLICT,
          { reportId },
        );
      }
      this.logger.error('Saving the report failed', (error as Error).stack);
      const failure = new ExtractionError('SAVE_FAILED', ExtractionStage.Save, 'The data could not be saved. Please retry.', true, result.method);
      await this.markFailed(document.id, attempt.id, failure, Date.now() - started);
      throw this.extractionFailed(document.id, failure);
    }

    this.logger.log(
      `Document ${document.id}: ${result.rows.length} rows via ${result.method} in ${Date.now() - started} ms (attempt ${attemptNo})`,
    );
    return this.findOne(document.id);
  }

  private async markFailed(documentId: string, attemptId: string, failure: ExtractionError, durationMs: number): Promise<void> {
    await this.dataSource.getRepository(ExtractionAttempt).update(attemptId, {
      status: AttemptStatus.Failed,
      failedStage: failure.stage,
      errorCode: failure.code,
      errorMessage: failure.message,
      extractionMethod: failure.method ?? null,
      durationMs,
      finishedAt: new Date(),
    });
    await this.documents.update(documentId, {
      status: DocumentStatus.Failed,
      lastErrorCode: failure.code,
      lastErrorMessage: failure.message,
      isRetryable: failure.retryable,
    });
  }

  // ---------------------------------------------------------------------------
  // Read and delete
  // ---------------------------------------------------------------------------

  async list(page: number, limit: number): Promise<{ items: DocumentSummary[]; page: number; limit: number; total: number }> {
    const [documents, total] = await this.documents.findAndCount({
      relations: { report: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const reportIds = documents.map((d) => d.report?.id).filter((id): id is string => !!id);
    const counts = new Map<string, number>();
    if (reportIds.length) {
      const rows: { report_fk: string; count: string }[] = await this.parameters
        .createQueryBuilder('p')
        .select('p.report_fk', 'report_fk')
        .addSelect('COUNT(*)', 'count')
        .where({ reportFk: In(reportIds), isSection: false })
        .groupBy('p.report_fk')
        .getRawMany();
      for (const r of rows) counts.set(r.report_fk, Number(r.count));
    }
    return {
      items: documents.map((d) => toDocumentSummary(d, d.report ? (counts.get(d.report.id) ?? 0) : 0)),
      page,
      limit,
      total,
    };
  }

  async findOne(id: string): Promise<DocumentDetail> {
    const document = await this.documents.findOne({
      where: { id },
      relations: { report: { parameters: true }, attempts: true },
      order: { report: { parameters: { rowOrder: 'ASC' } }, attempts: { attemptNo: 'ASC' } },
    });
    if (!document) throw notFound(id);
    return toDocumentDetail(document);
  }

  async getFile(id: string): Promise<{ document: Document; stream: NodeJS.ReadableStream }> {
    const document = await this.findDocument(id);
    return { document, stream: this.storage.stream(document.filePath) };
  }

  async remove(id: string): Promise<void> {
    await this.removeDocument(await this.findDocument(id));
  }

  private async removeDocument(document: Document): Promise<void> {
    await this.documents.delete(document.id); // attempts, report and parameters cascade
    await this.storage.delete(document.filePath);
  }

  private async findDocument(id: string): Promise<Document> {
    const document = await this.documents.findOneBy({ id });
    if (!document) throw notFound(id);
    return document;
  }

  private duplicateFile(existing: Document): AppException {
    return new AppException('DUPLICATE_FILE', `This PDF was already uploaded as "${existing.fileName}".`, HttpStatus.CONFLICT, {
      documentId: existing.id,
      documentStatus: existing.status,
      retryable: existing.status === DocumentStatus.Failed && existing.isRetryable,
    });
  }

  private extractionFailed(documentId: string, failure: ExtractionError): AppException {
    return new AppException(failure.code, failure.message, HttpStatus.UNPROCESSABLE_ENTITY, {
      documentId,
      stage: failure.stage,
      retryable: failure.retryable,
    });
  }
}

/** Report ID from the PDF, or AUTO-<yyyymmdd>-<first 6 of file hash> when the PDF has none. */
export function resolveReportId(found: string | undefined, fileHash: string): { reportId: string; idAutoGenerated: boolean } {
  if (found?.trim()) return { reportId: found.trim().toUpperCase().slice(0, 100), idAutoGenerated: false };
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return { reportId: `AUTO-${today}-${fileHash.slice(0, 6).toUpperCase()}`, idAutoGenerated: true };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === PG_UNIQUE_VIOLATION;
}

function notFound(id: string): AppException {
  return new AppException('DOCUMENT_NOT_FOUND', `Document ${id} was not found.`, HttpStatus.NOT_FOUND);
}


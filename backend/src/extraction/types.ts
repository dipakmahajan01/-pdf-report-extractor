import { ExtractionMethod, ExtractionStage } from '../database/enums.js';

/** A single word with its position on the page, in PDF points with a top-left origin. */
export interface Word {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-100, OCR only. */
  confidence?: number;
}

export interface Line {
  page: number;
  y: number;
  /** Sorted left to right. */
  words: Word[];
  text: string;
}

export interface PageContent {
  page: number;
  source: 'text' | 'ocr';
  lines: Line[];
  ocrConfidence?: number;
}

export interface ParsedRow {
  page: number;
  isSection: boolean;
  sectionName?: string;
  name: string;
  nameNormalized: string;
  valueRaw?: string;
  valueNumeric?: number;
  comparator?: string;
  unit?: string;
  refRangeRaw?: string;
  refLow?: number;
  refHigh?: number;
  flag?: 'H' | 'L';
  ocrConfidence?: number;
  extra?: Record<string, string>;
}

export interface ReportMetadata {
  reportId?: string;
  patientName?: string;
  /** ISO date, yyyy-mm-dd. */
  reportDate?: string;
  labName?: string;
}

export interface ExtractionWarning {
  code: string;
  message: string;
}

export interface ExtractionResult {
  pageCount: number;
  method: ExtractionMethod;
  metadata: ReportMetadata;
  rows: ParsedRow[];
  /** Share of non-section rows that have both a name and a value (0-1). */
  score: number;
  ocrConfidence?: number;
  rawText: string;
  warnings: ExtractionWarning[];
}

/** A failure inside the pipeline, with the stage it happened in and whether a retry can help. */
export class ExtractionError extends Error {
  constructor(
    readonly code: string,
    readonly stage: ExtractionStage,
    message: string,
    readonly retryable: boolean,
    readonly method?: ExtractionMethod,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

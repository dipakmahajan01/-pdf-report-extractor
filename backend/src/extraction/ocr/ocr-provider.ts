import type { Line } from '../types.js';

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

export interface OcrResult {
  /** Lines in PDF points (top-left origin), already grouped by the OCR engine. */
  lines: Line[];
  /** Average word confidence, 0-100. */
  confidence: number;
}

/**
 * OCR engine abstraction. Only Tesseract is implemented; a cloud OCR service could be
 * added behind this interface without touching the rest of the pipeline.
 */
export interface OcrProvider {
  recognize(png: Buffer, options: { dpi: number; page: number; psm: number }): Promise<OcrResult>;
}

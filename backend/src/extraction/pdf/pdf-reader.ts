import { createCanvas } from '@napi-rs/canvas';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ExtractionStage } from '../../database/enums.js';
import { ExtractionError, type Word } from '../types.js';

export type PdfDocument = PDFDocumentProxy;

export interface LoadedPdf {
  doc: PdfDocument;
  /** Frees pdf.js resources; call when done with the document. */
  close: () => Promise<void>;
}

export async function loadPdf(buffer: Buffer): Promise<LoadedPdf> {
  // Copy the bytes: pdf.js may detach the array it is given, and the buffer is reused on retry.
  const task = getDocument({ data: new Uint8Array(buffer), disableFontFace: true, verbosity: 0 });
  try {
    return { doc: await task.promise, close: () => task.destroy() };
  } catch (error) {
    if ((error as Error)?.name === 'PasswordException') {
      throw new ExtractionError('PASSWORD_PROTECTED', ExtractionStage.Load, 'The PDF is password-protected.', false);
    }
    throw new ExtractionError(
      'CORRUPTED_PDF',
      ExtractionStage.Load,
      'The PDF file is damaged and cannot be opened.',
      false,
    );
  }
}

/**
 * Reads the text layer of a page and returns single words with positions.
 * pdf.js gives text runs ("Total Cholesterol"); they are split into words so that
 * digital pages and OCR pages are handled by the same parser.
 */
export async function extractPageWords(doc: PdfDocument, pageNo: number): Promise<Word[]> {
  const page = await doc.getPage(pageNo);
  const pageHeight = page.getViewport({ scale: 1 }).height;
  const content = await page.getTextContent();
  const words: Word[] = [];

  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform as number[];
    const height = item.height || Math.abs(d) || 10;
    const charWidth = item.str.length ? item.width / item.str.length : 0;
    const top = pageHeight - f - height;

    for (const match of item.str.matchAll(/\S+/g)) {
      words.push({
        text: match[0],
        x: e + (match.index ?? 0) * charWidth,
        y: top,
        width: match[0].length * charWidth,
        height,
      });
    }
  }
  page.cleanup();
  return words;
}

export interface RenderOptions {
  dpi: number;
  /** Convert to pure black and white (helps OCR on noisy scans). */
  binarize?: boolean;
}

/** Renders a page to a PNG for OCR. */
export async function renderPage(doc: PdfDocument, pageNo: number, { dpi, binarize }: RenderOptions): Promise<Buffer> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport }).promise;
  page.cleanup();

  if (binarize) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    cleanScan(image.data, canvas.width, canvas.height);
    ctx.putImageData(image, 0, 0);
  }
  return canvas.toBuffer('image/png');
}

/**
 * Black-and-white conversion followed by a 3x3 median filter, which removes isolated
 * specks (scanner dust) while keeping letter strokes.
 */
function cleanScan(px: Uint8ClampedArray, width: number, height: number): void {
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < ink.length; i += 4, p++) {
    ink[p] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 170 ? 1 : 0;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          count += ink[yy * width + Math.min(width - 1, Math.max(0, x + dx))];
        }
      }
      const v = count >= 5 ? 0 : 255;
      const i = (y * width + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
}

import { Module } from '@nestjs/common';
import { ExtractionService } from './extraction.service.js';
import { OCR_PROVIDER } from './ocr/ocr-provider.js';
import { TesseractOcrProvider } from './ocr/tesseract-ocr.provider.js';

@Module({
  providers: [ExtractionService, { provide: OCR_PROVIDER, useClass: TesseractOcrProvider }],
  exports: [ExtractionService],
})
export class ExtractionModule {}

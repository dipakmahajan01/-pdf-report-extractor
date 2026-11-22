import { Module } from '@nestjs/common';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { FileStorageService } from './file-storage.service.js';

@Module({
  imports: [ExtractionModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, FileStorageService],
})
export class DocumentsModule {}

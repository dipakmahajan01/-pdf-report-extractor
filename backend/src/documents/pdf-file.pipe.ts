import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from '../common/app.exception.js';

const PDF_MIME_TYPES = ['application/pdf', 'application/x-pdf', 'application/octet-stream'];

/** Rejects anything that is not a PDF before it reaches the service: extension, MIME type and the %PDF- magic bytes. */
@Injectable()
export class PdfFilePipe implements PipeTransform<Express.Multer.File | undefined, Express.Multer.File> {
  transform(file: Express.Multer.File | undefined): Express.Multer.File {
    if (!file) {
      throw new AppException('FILE_MISSING', 'Please choose a PDF file to upload (form field "file").', HttpStatus.BAD_REQUEST);
    }
    const isPdf =
      file.originalname.toLowerCase().endsWith('.pdf') &&
      PDF_MIME_TYPES.includes(file.mimetype) &&
      file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!isPdf) {
      throw new AppException('INVALID_FILE_TYPE', `"${file.originalname}" is not a valid PDF file.`, HttpStatus.BAD_REQUEST);
    }
    return file;
  }
}

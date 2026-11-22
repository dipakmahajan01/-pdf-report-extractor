import { HttpException, HttpStatus } from '@nestjs/common';

/** An HTTP error with a stable machine-readable code (the UI switches on `code`, not on the message). */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, status);
  }
}

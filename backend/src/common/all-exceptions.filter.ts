import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

const CODES_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
};

/** Gives every error the same JSON shape and never leaks internals on a 500. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body =
        typeof response === 'object' && response !== null
          ? { ...(response as Record<string, unknown>) }
          : { message: response };
      body.code ??= CODES_BY_STATUS[status] ?? 'ERROR';
      if (Array.isArray(body.message)) body.message = body.message.join('; ');
      delete body.statusCode;
      delete body.error;
    } else {
      this.logger.error(`${req.method} ${req.url} failed`, (exception as Error)?.stack);
    }

    res.status(status).json({ statusCode: status, ...body, path: req.url, timestamp: new Date().toISOString() });
  }
}

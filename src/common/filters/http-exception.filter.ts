import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

/**
 * Formats every error response. Only `HttpException` messages (written for clients) are exposed;
 * anything else is logged server-side and returned as a generic 500, so internals such as database
 * errors, file paths, or stack traces never reach clients.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const path = request.originalUrl.split('?')[0];

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const fields = body as Record<string, unknown>;
        message = (fields.message as string | string[] | undefined) ?? exception.message;
        error = (fields.error as string | undefined) ?? exception.name;
      }
      if (exception instanceof ThrottlerException) error = 'Too Many Requests';
    } else if (isBodyParserError(exception)) {
      // Express body parser errors (payload too large, malformed JSON) carry a safe status
      status = exception.status;
      message =
        exception.type === 'entity.too.large'
          ? 'Request body is too large'
          : 'Malformed request body';
      error = status === 413 ? 'Payload Too Large' : 'Bad Request';
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${path} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const payload: ErrorResponse = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path,
    };
    response.status(status).json(payload);
  }
}

function isBodyParserError(exception: unknown): exception is { status: number; type: string } {
  if (typeof exception !== 'object' || exception === null) return false;
  const { status, type } = exception as Record<string, unknown>;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string';
}

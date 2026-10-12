import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const responseTime = Date.now() - startTime;
          this.logger.log(`${method} ${url} - ${responseTime}ms`);
        },
        error: (error: Error) => {
          const responseTime = Date.now() - startTime;
          const line = `${method} ${url} - ${responseTime}ms - ${error.message}`;
          // Client errors are expected traffic; only server errors are logged as errors
          if (error instanceof HttpException && error.getStatus() < 500) this.logger.warn(line);
          else this.logger.error(line);
        },
      }),
    );
  }
}

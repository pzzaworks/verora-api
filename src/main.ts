import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import type { EnvironmentVariables } from './config/env.validation.js';

/** Covers the largest legitimate body: metadata with a 256KB icon and a 512KB banner, base64-encoded */
const BODY_LIMIT = '1.1mb';
const DOCS_PATH = '/api/docs';

/** Version shown in the API docs, read from package.json (the working directory in dev and in the image) */
function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    const { version } = parsed;
    if (typeof version === 'string') return version;
  }
  throw new Error('package.json has no version');
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  app.disable('x-powered-by');
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: '16kb', extended: false });

  const swaggerEnabled = config.get('SWAGGER_ENABLED', { infer: true });
  const strictHeaders = helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } });
  // The docs UI loads its scripts from a CDN, so only its path drops the CSP; everything else keeps
  // helmet's strict default
  const docsHeaders = helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isDocs = req.path === DOCS_PATH || req.path.startsWith(`${DOCS_PATH}/`);
    return swaggerEnabled && isDocs ? docsHeaders(req, res, next) : strictHeaders(req, res, next);
  });

  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  app.useStaticAssets(join(process.cwd(), 'public'), { index: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableShutdownHooks();

  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Verora API')
        .setDescription('Indexer, oracle, and metadata service for the Verora AI oracle network')
        .setVersion(packageVersion())
        .addBearerAuth()
        .build(),
    );
    (document.info as unknown as Record<string, unknown>)['x-logo'] = {
      url: '/logo-full-white.svg',
      altText: 'Verora',
    };
    app.use(
      DOCS_PATH,
      apiReference({
        content: document,
        theme: 'saturn',
        darkMode: true,
        favicon: '/favicon.png',
        metaData: { title: 'Verora API Docs' },
        hiddenClients: true,
      }),
    );
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`Verora API listening on port ${port}${swaggerEnabled ? ' (docs at /api/docs)' : ''}`);
}

void bootstrap();

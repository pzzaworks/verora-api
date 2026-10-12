import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChainService } from '../chain/chain.service.js';
import { describeError } from '../common/errors.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const ICON_MAX_BYTES = 256 * 1024;
export const BANNER_MAX_BYTES = 512 * 1024;

/** Per-uploader storage quota. Garbage collection frees quota held by documents no agent uses. */
export const MAX_DOCUMENTS_PER_OWNER = 50;
export const MAX_ASSET_BYTES_PER_OWNER = 10 * 1024 * 1024;

/** Unreferenced documents and images are kept this long, covering the upload -> register -> index window */
export const GC_GRACE_MS = 24 * 60 * 60_000;
const GC_INTERVAL_MS = 60 * 60_000;
const GC_FIRST_RUN_MS = 60_000;
const GC_BATCH = 500;
/** GC only runs when the indexer is this close to the head, so unindexed registrations can't lose metadata */
const GC_MAX_INDEXER_LAG_BLOCKS = 100n;
const INDEXER_CURSOR_ID = 'main';

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (bytes: Buffer) => boolean }> = [
  {
    mimeType: 'image/png',
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mimeType: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mimeType: 'image/gif',
    matches: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
  {
    mimeType: 'image/webp',
    matches: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export interface AgentMetadataInput {
  name: string;
  description: string;
  publicKey?: string;
  website?: string;
  icon?: string;
  banner?: string;
}

export interface StoredMetadata {
  id: string;
  uri: string;
}

export interface GarbageCollectionResult {
  skipped: boolean;
  documents: number;
  assets: number;
}

interface ParsedImage {
  id: string;
  mimeType: string;
  bytes: Buffer<ArrayBuffer>;
}

/**
 * Hosts agent metadata so registration stores a short URI on-chain instead of a large `data:` URI.
 * Documents and images are content-addressed (SHA-256), immutable, and attributed to the uploader.
 * Images are accepted only as PNG, JPEG, GIF, or WebP, verified by magic bytes (no SVG, so no script).
 *
 * Uploads count against a per-owner quota, and a periodic collector removes documents no agent
 * references and images no document or agent references, once they are older than a grace period.
 */
@Injectable()
export class MetadataService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MetadataService.name);
  private readonly baseUrl: string;
  private readonly workersEnabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.baseUrl = config.get('PUBLIC_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.workersEnabled = config.get('WORKERS_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.workersEnabled) this.scheduleGc(GC_FIRST_RUN_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async store(owner: string, input: AgentMetadataInput): Promise<StoredMetadata> {
    const icon = input.icon ? parseImage(input.icon, ICON_MAX_BYTES, 'icon') : undefined;
    const banner = input.banner ? parseImage(input.banner, BANNER_MAX_BYTES, 'banner') : undefined;
    const images = [icon, banner].filter((image): image is ParsedImage => image !== undefined);

    const content: Record<string, string> = { name: input.name, description: input.description };
    if (input.publicKey) content.publicKey = input.publicKey;
    if (input.website) content.website = input.website;
    if (icon) content.image = this.assetUrl(icon.id);
    if (banner) content.banner = this.assetUrl(banner.id);

    const canonical = JSON.stringify(content, Object.keys(content).sort());
    const id = sha256(Buffer.from(canonical));

    await this.assertWithinQuota(owner, id, images);

    // Re-storing existing content refreshes lastUsedAt, which keeps it out of garbage collection
    const now = new Date();
    for (const image of images) {
      await this.prisma.asset.upsert({
        where: { id: image.id },
        create: {
          id: image.id,
          owner,
          mimeType: image.mimeType,
          size: image.bytes.length,
          data: image.bytes,
        },
        update: { lastUsedAt: now },
      });
    }
    await this.prisma.metadataDocument.upsert({
      where: { id },
      create: { id, owner, content },
      update: { lastUsedAt: now },
    });

    return { id, uri: `${this.baseUrl}/metadata/${id}` };
  }

  async getDocument(id: string): Promise<Record<string, unknown>> {
    const document = await this.prisma.metadataDocument.findUnique({ where: { id } });
    if (!document) throw new NotFoundException('Metadata not found');
    return document.content as Record<string, unknown>;
  }

  async getAsset(id: string): Promise<{ mimeType: string; data: Buffer }> {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    return { mimeType: asset.mimeType, data: Buffer.from(asset.data) };
  }

  /** Whether a metadata URI points at this API, so it can be resolved without an outbound request */
  localDocumentId(uri: string): string | null {
    const prefix = `${this.baseUrl}/metadata/`;
    if (!uri.startsWith(prefix)) return null;
    const id = uri.slice(prefix.length);
    return /^[0-9a-f]{64}$/.test(id) ? id : null;
  }

  /**
   * Deletes stale documents that no indexed agent points at, then stale images that no document
   * and no agent's resolved metadata points at. References are matched by the `/metadata/<id>` and
   * `/assets/<id>` suffix, so a changed PUBLIC_BASE_URL can't make every row look unreferenced.
   * The staleness and reference checks are repeated in the outer DELETE, so a row refreshed or
   * referenced while the statement runs is re-checked and kept.
   */
  async collectGarbage(): Promise<GarbageCollectionResult> {
    if (!(await this.indexerCaughtUp())) return { skipped: true, documents: 0, assets: 0 };

    const cutoff = new Date(Date.now() - GC_GRACE_MS);
    const documents = await this.prisma.$executeRaw`
      DELETE FROM "metadata_documents" AS d
      WHERE d."last_used_at" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "agents" AS a WHERE a."metadata_uri" LIKE ('%/metadata/' || d."id")
        )
        AND d."id" IN (
          SELECT c."id" FROM "metadata_documents" AS c
          WHERE c."last_used_at" < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM "agents" AS a WHERE a."metadata_uri" LIKE ('%/metadata/' || c."id")
            )
          LIMIT ${GC_BATCH}
        )`;

    const assets = await this.prisma.$executeRaw`
      DELETE FROM "assets" AS s
      WHERE s."last_used_at" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "metadata_documents" AS d
          WHERE d."content"->>'image' LIKE ('%/assets/' || s."id")
             OR d."content"->>'banner' LIKE ('%/assets/' || s."id")
        )
        AND NOT EXISTS (
          SELECT 1 FROM "agents" AS a
          WHERE a."metadata"->>'image' LIKE ('%/assets/' || s."id")
             OR a."metadata"->>'banner' LIKE ('%/assets/' || s."id")
        )
        AND s."id" IN (
          SELECT c."id" FROM "assets" AS c WHERE c."last_used_at" < ${cutoff} LIMIT ${GC_BATCH}
        )`;

    return { skipped: false, documents, assets };
  }

  private scheduleGc(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runGc(), delayMs);
  }

  private async runGc(): Promise<void> {
    try {
      const result = await this.collectGarbage();
      if (result.skipped) {
        this.logger.log('Metadata garbage collection skipped: the indexer is not caught up');
      } else if (result.documents > 0 || result.assets > 0) {
        this.logger.log(
          `Removed ${result.documents} unreferenced metadata documents and ${result.assets} images`,
        );
      }
    } catch (error) {
      this.logger.error(`Metadata garbage collection failed: ${describeError(error)}`);
    }
    this.scheduleGc(GC_INTERVAL_MS);
  }

  /** References live in indexed agents, so GC must not run against a stale or rebuilding index */
  private async indexerCaughtUp(): Promise<boolean> {
    const [cursor, safeHead] = await Promise.all([
      this.prisma.indexerState.findUnique({ where: { id: INDEXER_CURSOR_ID } }),
      this.chain.getSafeBlockNumber(),
    ]);
    return cursor !== null && safeHead - cursor.lastBlock <= GC_MAX_INDEXER_LAG_BLOCKS;
  }

  private async assertWithinQuota(
    owner: string,
    documentId: string,
    images: ParsedImage[],
  ): Promise<void> {
    const [existingDocument, existingAssets, documentCount, assetUsage] = await Promise.all([
      this.prisma.metadataDocument.findUnique({ where: { id: documentId }, select: { id: true } }),
      images.length > 0
        ? this.prisma.asset.findMany({
            where: { id: { in: images.map((image) => image.id) } },
            select: { id: true },
          })
        : Promise.resolve([]),
      this.prisma.metadataDocument.count({ where: { owner } }),
      this.prisma.asset.aggregate({ where: { owner }, _sum: { size: true } }),
    ]);

    // Content that is already stored (by anyone) is deduplicated and costs nothing
    if (!existingDocument && documentCount >= MAX_DOCUMENTS_PER_OWNER) {
      throw new ForbiddenException(
        `Metadata quota exceeded: at most ${MAX_DOCUMENTS_PER_OWNER} documents per wallet`,
      );
    }
    // Seeded with stored IDs so an icon reused as the banner is only counted once
    const counted = new Set(existingAssets.map((asset) => asset.id));
    let newBytes = 0;
    for (const image of images) {
      if (counted.has(image.id)) continue;
      counted.add(image.id);
      newBytes += image.bytes.length;
    }
    if ((assetUsage._sum.size ?? 0) + newBytes > MAX_ASSET_BYTES_PER_OWNER) {
      throw new ForbiddenException(
        `Metadata quota exceeded: at most ${MAX_ASSET_BYTES_PER_OWNER / (1024 * 1024)}MB of images per wallet`,
      );
    }
  }

  private assetUrl(id: string): string {
    return `${this.baseUrl}/assets/${id}`;
  }
}

function parseImage(dataUrl: string, maxBytes: number, field: string): ParsedImage {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new BadRequestException(`${field} must be a base64 image data URL`);

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new BadRequestException(`${field} must be at most ${Math.floor(maxBytes / 1024)}KB`);
  }

  const detected = IMAGE_SIGNATURES.find((signature) => signature.matches(bytes));
  if (!detected) throw new BadRequestException(`${field} must be a PNG, JPEG, GIF, or WebP image`);

  return { id: sha256(bytes), mimeType: detected.mimeType, bytes };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

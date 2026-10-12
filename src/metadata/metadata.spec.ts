import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeAgentMetadata } from '../agents/agent-metadata.js';
import type { ChainService } from '../chain/chain.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ICON_MAX_BYTES,
  MAX_ASSET_BYTES_PER_OWNER,
  MAX_DOCUMENTS_PER_OWNER,
  MetadataService,
} from './metadata.service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const dataUrl = (bytes: Buffer, mime = 'image/png') =>
  `data:${mime};base64,${bytes.toString('base64')}`;

interface Usage {
  documents?: number;
  assetBytes?: number;
  existingDocument?: boolean;
  cursor?: bigint | null;
  safeHead?: bigint;
}

function createService(usage: Usage = {}) {
  const prisma = {
    asset: {
      upsert: vi.fn((_args: { create: { mimeType: string } }) => Promise.resolve({})),
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { size: usage.assetBytes ?? 0 } }),
    },
    metadataDocument: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(usage.existingDocument ? { id: 'x' } : null),
      count: vi.fn().mockResolvedValue(usage.documents ?? 0),
    },
    indexerState: {
      findUnique: vi
        .fn()
        .mockResolvedValue(usage.cursor === null ? null : { lastBlock: usage.cursor ?? 1000n }),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const chain = { getSafeBlockNumber: () => Promise.resolve(usage.safeHead ?? 1000n) };
  const values = new Map<keyof EnvironmentVariables, string | boolean>([
    ['PUBLIC_BASE_URL', 'https://api.verora.test/'],
    ['WORKERS_ENABLED', false],
  ]);
  const config = {
    get: (key: keyof EnvironmentVariables) => values.get(key),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return {
    service: new MetadataService(
      prisma as unknown as PrismaService,
      chain as unknown as ChainService,
      config,
    ),
    prisma,
  };
}

describe('MetadataService', () => {
  it('stores content-addressed documents with hosted image URLs', async () => {
    const { service, prisma } = createService();
    const first = await service.store('0xabc', {
      name: 'Agent',
      description: 'd',
      icon: dataUrl(PNG),
    });
    const second = await service.store('0xabc', {
      description: 'd',
      icon: dataUrl(PNG),
      name: 'Agent',
    });

    expect(first.uri).toBe(`https://api.verora.test/metadata/${first.id}`);
    expect(second.id).toBe(first.id);
    expect(prisma.asset.upsert.mock.calls[0]?.[0].create.mimeType).toBe('image/png');
  });

  it('rejects SVG, mislabeled bytes, and oversized images', async () => {
    const { service } = createService();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    await expect(
      service.store('0xabc', { name: 'a', description: 'd', icon: dataUrl(svg, 'image/svg+xml') }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.store('0xabc', { name: 'a', description: 'd', icon: dataUrl(svg) }),
    ).rejects.toThrow(/PNG, JPEG, GIF, or WebP/);
    const huge = Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]);
    await expect(
      service.store('0xabc', { name: 'a', description: 'd', icon: dataUrl(huge) }),
    ).rejects.toThrow(/at most/);
  });

  it('enforces the per-owner document and image quotas, but not for deduplicated content', async () => {
    const full = createService({ documents: MAX_DOCUMENTS_PER_OWNER });
    await expect(full.service.store('0xabc', { name: 'a', description: 'd' })).rejects.toThrow(
      /quota/,
    );
    expect(full.prisma.metadataDocument.upsert).not.toHaveBeenCalled();

    const existing = createService({ documents: MAX_DOCUMENTS_PER_OWNER, existingDocument: true });
    await expect(
      existing.service.store('0xabc', { name: 'a', description: 'd' }),
    ).resolves.toBeDefined();

    const nearlyFull = createService({ assetBytes: MAX_ASSET_BYTES_PER_OWNER - 4 });
    await expect(
      nearlyFull.service.store('0xabc', { name: 'a', description: 'd', icon: dataUrl(PNG) }),
    ).rejects.toThrow(/quota/);
    expect(nearlyFull.prisma.asset.upsert).not.toHaveBeenCalled();
  });

  it('skips garbage collection unless the indexer is caught up', async () => {
    const behind = createService({ cursor: 10n, safeHead: 10_000n });
    await expect(behind.service.collectGarbage()).resolves.toMatchObject({ skipped: true });
    expect(behind.prisma.$executeRaw).not.toHaveBeenCalled();

    const fresh = createService({ cursor: null });
    await expect(fresh.service.collectGarbage()).resolves.toMatchObject({ skipped: true });

    const current = createService({ cursor: 995n, safeHead: 1000n });
    await expect(current.service.collectGarbage()).resolves.toMatchObject({ skipped: false });
    expect(current.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('recognizes only its own canonical metadata URIs', () => {
    const { service } = createService();
    const id = 'a'.repeat(64);
    expect(service.localDocumentId(`https://api.verora.test/metadata/${id}`)).toBe(id);
    expect(service.localDocumentId(`https://evil.test/metadata/${id}`)).toBeNull();
    expect(service.localDocumentId('https://api.verora.test/metadata/../x')).toBeNull();
  });
});

describe('sanitizeAgentMetadata', () => {
  it('keeps known fields and drops unsafe URLs and unknown keys', () => {
    const result = sanitizeAgentMetadata(
      {
        name: ' Oracle ',
        description: 'Prices',
        image: 'javascript:alert(1)',
        banner: 'https://cdn.example.com/b.png',
        website: 'http://insecure.example.com',
        publicKey: 'not-a-key',
        extra: 'dropped',
      },
      'https://api.verora.test',
    );
    expect(result).toEqual({
      name: 'Oracle',
      description: 'Prices',
      banner: 'https://cdn.example.com/b.png',
    });
  });

  it('allows the API origin over http for local development', () => {
    expect(
      sanitizeAgentMetadata({ image: 'http://localhost:4100/assets/1' }, 'http://localhost:4100'),
    ).toEqual({ image: 'http://localhost:4100/assets/1' });
  });

  it('returns an empty object for non-object input', () => {
    expect(sanitizeAgentMetadata(['x'], 'https://a')).toEqual({});
    expect(sanitizeAgentMetadata(null, 'https://a')).toEqual({});
  });
});

import { Injectable } from '@nestjs/common';
import { ChainService } from './chain/chain.service.js';
import { IndexerService, type IndexerStatus } from './indexer/indexer.service.js';
import { PrismaService } from './prisma/prisma.service.js';

/** The API is degraded when the indexer falls this many blocks behind the safe head */
const MAX_HEALTHY_LAG_BLOCKS = 100;

/** /health is public and unthrottled, so probes are shared instead of hitting the DB and RPC per request */
const HEALTH_CACHE_MS = 5000;

/** Public health output: booleans, block numbers, and error class names only, never error messages */
export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    database: boolean;
    rpc: boolean;
    indexer: IndexerStatus;
  };
}

@Injectable()
export class AppService {
  private cached: { report: HealthReport; expiresAt: number } | null = null;
  private inFlight: Promise<HealthReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    private readonly indexer: IndexerService,
  ) {}

  async getHealth(): Promise<HealthReport> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.report;
    // Concurrent requests while a probe is running share it
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async probe(): Promise<HealthReport> {
    const [database, rpc] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      ),
      this.chain.publicClient.getBlockNumber().then(
        () => true,
        () => false,
      ),
    ]);

    const indexer = this.indexer.getStatus();
    // An instance without the indexer (INDEXER_ENABLED=false) only serves reads; its lag is not its own
    const lagging =
      indexer.enabled &&
      (indexer.lagBlocks === null ||
        indexer.lagBlocks > MAX_HEALTHY_LAG_BLOCKS ||
        indexer.lastErrorKind !== null);
    const status = !database || !rpc ? 'unhealthy' : lagging ? 'degraded' : 'healthy';

    const report: HealthReport = {
      status,
      timestamp: new Date().toISOString(),
      checks: { database, rpc, indexer },
    };
    this.cached = { report, expiresAt: Date.now() + HEALTH_CACHE_MS };
    return report;
  }
}

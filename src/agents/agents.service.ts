import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Agent } from '@prisma/client';
import { parseJsonBody, safeFetch } from '../common/safe-fetch.js';
import type { Paginated } from '../common/dto/pagination.dto.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sanitizeAgentMetadata, type AgentMetadata } from './agent-metadata.js';
import type { ListAgentsQueryDto } from './dto/list-agents.dto.js';

const METADATA_INTERVAL_MS = 10_000;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_STALE_MS = 2 * 60_000;
const WORKER_BATCH = 25;
const METADATA_RETRY_BASE_MS = 60_000;
const METADATA_RETRY_MAX_MS = 6 * 60 * 60_000;
/** After this many failed resolutions the agent keeps its error until its metadata URI changes */
const METADATA_MAX_ATTEMPTS = 8;

export interface AgentView {
  id: string;
  owner: string;
  endpoint: string;
  capabilities: string[];
  metadataUri: string;
  metadata: AgentMetadata | null;
  status: string;
  adminSuspended: boolean;
  registeredAt: string;
  reputation: number;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  totalStake: string;
  stakerCount: number;
  healthStatus: string;
  healthCheckedAt: string | null;
}

@Injectable()
export class AgentsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentsService.name);
  private readonly allowPrivate: boolean;
  private readonly trustedOrigin: string;
  private readonly workersEnabled: boolean;
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: MetadataService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.allowPrivate = config.get('ALLOW_PRIVATE_AGENT_ENDPOINTS', { infer: true });
    this.trustedOrigin = new URL(config.get('PUBLIC_BASE_URL', { infer: true })).origin;
    this.workersEnabled = config.get('WORKERS_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.workersEnabled) return;
    this.loop(() => this.resolvePendingMetadata(), METADATA_INTERVAL_MS);
    this.loop(() => this.checkHealth(), HEALTH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  async list(query: ListAgentsQueryDto): Promise<Paginated<AgentView>> {
    const where: Prisma.AgentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.owner ? { owner: query.owner.toLowerCase() } : {}),
      ...(query.capability ? { capabilities: { has: query.capability } } : {}),
      ...(query.search
        ? { metadata: { path: ['name'], string_contains: query.search, mode: 'insensitive' } }
        : {}),
    };
    const orderBy: Prisma.AgentOrderByWithRelationInput =
      query.sort === 'stake'
        ? { totalStake: 'desc' }
        : query.sort === 'newest'
          ? { registeredAt: 'desc' }
          : { reputation: 'desc' };

    const [agents, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        orderBy: [orderBy, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.agent.count({ where }),
    ]);

    return { data: agents.map(toView), page: query.page, limit: query.limit, total };
  }

  async get(id: string): Promise<AgentView> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException('Agent not found');
    return toView(agent);
  }

  /**
   * Resolves metadata for agents whose URI changed since the last fetch, and retries failed
   * resolutions (unreachable host, HTTP error, invalid JSON) with exponential backoff.
   */
  async resolvePendingMetadata(): Promise<void> {
    const agents = await this.prisma.agent.findMany({
      where: { OR: [{ metadataFetchedAt: null }, { metadataRetryAt: { lte: new Date() } }] },
      select: { id: true, metadataUri: true, metadataAttempts: true },
      orderBy: { metadataRetryAt: { sort: 'asc', nulls: 'first' } },
      take: WORKER_BATCH,
    });

    for (const agent of agents) {
      let metadata: AgentMetadata | null = null;
      let error: string | null = null;
      try {
        metadata = await this.fetchMetadata(agent.metadataUri);
      } catch (cause) {
        error = cause instanceof Error ? cause.message.slice(0, 300) : 'Failed to resolve metadata';
      }

      const attempts = error === null ? 0 : agent.metadataAttempts + 1;
      const retryAt =
        error !== null && attempts < METADATA_MAX_ATTEMPTS
          ? new Date(
              Date.now() +
                Math.min(METADATA_RETRY_BASE_MS * 2 ** (attempts - 1), METADATA_RETRY_MAX_MS),
            )
          : null;

      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          metadata: metadata ? (metadata as Prisma.InputJsonObject) : Prisma.DbNull,
          metadataFetchedAt: new Date(),
          metadataError: error,
          metadataAttempts: attempts,
          metadataRetryAt: retryAt,
        },
      });
    }
  }

  private async fetchMetadata(uri: string): Promise<AgentMetadata | null> {
    if (!uri) return null;

    const localId = this.metadataService.localDocumentId(uri);
    if (localId) {
      return sanitizeAgentMetadata(
        await this.metadataService.getDocument(localId),
        this.trustedOrigin,
      );
    }

    const url = uri.startsWith('ipfs://')
      ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`
      : uri;
    const result = await safeFetch(url, {
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
      allowPrivate: this.allowPrivate,
    });
    if (result.status !== 200) throw new Error(`Metadata URI returned HTTP ${result.status}`);
    return sanitizeAgentMetadata(parseJsonBody<unknown>(result), this.trustedOrigin);
  }

  /** Probes `<endpoint origin>/health` for active agents */
  async checkHealth(): Promise<void> {
    const agents = await this.prisma.agent.findMany({
      where: {
        status: 'active',
        OR: [
          { healthCheckedAt: null },
          { healthCheckedAt: { lt: new Date(Date.now() - HEALTH_STALE_MS) } },
        ],
      },
      select: { id: true, endpoint: true },
      take: WORKER_BATCH,
    });

    await Promise.all(
      agents.map(async (agent) => {
        let healthy = false;
        try {
          const healthUrl = new URL('/health', new URL(agent.endpoint).origin).toString();
          const result = await safeFetch(healthUrl, {
            timeoutMs: 5000,
            maxBytes: 8 * 1024,
            allowPrivate: this.allowPrivate,
          });
          healthy = result.status >= 200 && result.status < 300;
        } catch {
          healthy = false;
        }
        await this.prisma.agent.update({
          where: { id: agent.id },
          data: { healthStatus: healthy ? 'healthy' : 'unhealthy', healthCheckedAt: new Date() },
        });
      }),
    );
  }

  private loop(task: () => Promise<void>, intervalMs: number): void {
    const run = async () => {
      try {
        await task();
      } catch (error) {
        this.logger.error(
          `Agent worker failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!this.stopped) this.timers.push(setTimeout(() => void run(), intervalMs));
    };
    this.timers.push(setTimeout(() => void run(), 1000));
  }
}

function toView(agent: Agent): AgentView {
  return {
    id: agent.id,
    owner: agent.owner,
    endpoint: agent.endpoint,
    capabilities: agent.capabilities,
    metadataUri: agent.metadataUri,
    metadata: (agent.metadata as AgentMetadata | null) ?? null,
    status: agent.status,
    adminSuspended: agent.adminSuspended,
    registeredAt: agent.registeredAt.toISOString(),
    reputation: agent.reputation,
    totalQueries: agent.totalQueries,
    successfulQueries: agent.successfulQueries,
    failedQueries: agent.failedQueries,
    totalStake: agent.totalStake.toFixed(0),
    stakerCount: agent.stakerCount,
    healthStatus: agent.healthStatus,
    healthCheckedAt: agent.healthCheckedAt?.toISOString() ?? null,
  };
}

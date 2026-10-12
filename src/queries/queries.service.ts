import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Query, QueryDispatch, QueryResponse } from '@prisma/client';
import type { Paginated } from '../common/dto/pagination.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListQueriesDto } from './dto/list-queries.dto.js';

export interface QueryView {
  id: string;
  requester: string;
  queryType: string;
  queryData: string;
  status: string;
  cancelled: boolean;
  payment: string;
  deadline: string;
  assignedAgents: string[];
  aggregatedResult: string | null;
  createdAt: string;
  finalizedAt: string | null;
  txHash: string;
}

export interface QueryDetailView extends QueryView {
  responses: Array<{ agentId: string; responseData: string; submittedAt: string; txHash: string }>;
  dispatches: Array<{
    agentId: string;
    status: string;
    attempts: number;
    lastError: string | null;
  }>;
}

export interface NetworkStats {
  totalQueries: number;
  completedQueries: number;
  failedQueries: number;
  openQueries: number;
  totalVolume: string;
  activeAgents: number;
  totalAgents: number;
}

@Injectable()
export class QueriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListQueriesDto): Promise<Paginated<QueryView>> {
    const where: Prisma.QueryWhereInput = {
      ...(query.requester ? { requester: query.requester.toLowerCase() } : {}),
      ...(query.agentId ? { assignedAgents: { has: query.agentId.toLowerCase() } } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [queries, total] = await Promise.all([
      this.prisma.query.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.query.count({ where }),
    ]);
    return { data: queries.map(toView), page: query.page, limit: query.limit, total };
  }

  async get(id: string): Promise<QueryDetailView> {
    const query = await this.prisma.query.findUnique({
      where: { id },
      include: { responses: { orderBy: { submittedAt: 'asc' } }, dispatches: true },
    });
    if (!query) throw new NotFoundException('Query not found');
    return toDetailView(query);
  }

  async stats(): Promise<NetworkStats> {
    const [byStatus, volume, activeAgents, totalAgents] = await Promise.all([
      this.prisma.query.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.query.aggregate({ _sum: { payment: true } }),
      this.prisma.agent.count({ where: { status: 'active' } }),
      this.prisma.agent.count(),
    ]);
    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      totalQueries: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      completedQueries: count('completed'),
      failedQueries: count('failed'),
      openQueries: count('pending') + count('in_progress'),
      totalVolume: volume._sum.payment?.toFixed(0) ?? '0',
      activeAgents,
      totalAgents,
    };
  }
}

function toView(query: Query): QueryView {
  return {
    id: query.id,
    requester: query.requester,
    queryType: query.queryType,
    queryData: query.queryData,
    status: query.status,
    cancelled: query.cancelled,
    payment: query.payment.toFixed(0),
    deadline: query.deadline.toISOString(),
    assignedAgents: query.assignedAgents,
    aggregatedResult: query.aggregatedResult,
    createdAt: query.createdAt.toISOString(),
    finalizedAt: query.finalizedAt?.toISOString() ?? null,
    txHash: query.txHash,
  };
}

function toDetailView(
  query: Query & { responses: QueryResponse[]; dispatches: QueryDispatch[] },
): QueryDetailView {
  return {
    ...toView(query),
    responses: query.responses.map((response) => ({
      agentId: response.agentId,
      responseData: response.responseData,
      submittedAt: response.submittedAt.toISOString(),
      txHash: response.txHash,
    })),
    dispatches: query.dispatches.map((dispatch) => ({
      agentId: dispatch.agentId,
      status: dispatch.status,
      attempts: dispatch.attempts,
      lastError: dispatch.lastError,
    })),
  };
}

import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppService, type HealthReport } from './app.service.js';

@ApiTags('Health')
@SkipThrottle()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Service banner' })
  getRoot(): { service: string } {
    return { service: 'Verora API' };
  }

  @Get('health')
  @ApiOperation({ summary: 'Health of the database, RPC, and indexer (503 when unhealthy)' })
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.appService.getHealth();
    if (report.status === 'unhealthy') res.status(503);
    return report;
  }
}

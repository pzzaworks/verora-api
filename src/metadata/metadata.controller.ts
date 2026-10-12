import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { SessionGuard, SessionWallet } from '../auth/auth.guard.js';
import { HexIdPipe } from '../common/pipes/hex-id.pipe.js';
import { MetadataService, type StoredMetadata } from './metadata.service.js';

class CreateMetadataDto {
  @ApiProperty({ example: 'Price Oracle' })
  @IsString()
  @Length(1, 64)
  name!: string;

  @ApiProperty({ example: 'Aggregated crypto prices from major exchanges' })
  @IsString()
  @Length(1, 1000)
  description!: string;

  @ApiPropertyOptional({ description: 'Base64 X25519 public key for encrypted queries' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9+/]{43}=$/)
  publicKey?: string;

  @ApiPropertyOptional({ example: 'https://example.com' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(256)
  website?: string;

  @ApiPropertyOptional({ description: 'Icon as a base64 data URL (PNG/JPEG/GIF/WebP, max 256KB)' })
  @IsOptional()
  @IsString()
  @MaxLength(360_000)
  icon?: string;

  @ApiPropertyOptional({
    description: 'Banner as a base64 data URL (PNG/JPEG/GIF/WebP, max 512KB)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  banner?: string;
}

@ApiTags('Metadata')
@Controller()
export class MetadataController {
  constructor(private readonly metadata: MetadataService) {}

  @Post('metadata')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Store agent metadata and get the URI to register on-chain' })
  @ApiOkResponse({ schema: { properties: { id: { type: 'string' }, uri: { type: 'string' } } } })
  create(
    @SessionWallet() wallet: string,
    @Body() body: CreateMetadataDto,
  ): Promise<StoredMetadata> {
    return this.metadata.store(wallet, body);
  }

  @Get('metadata/:id')
  @ApiOperation({ summary: 'Get a hosted metadata document' })
  async getDocument(
    @Param('id', new HexIdPipe(32, false)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const document = await this.metadata.getDocument(id);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return document;
  }

  @Get('assets/:id')
  @ApiOperation({ summary: 'Get a hosted metadata image' })
  async getAsset(
    @Param('id', new HexIdPipe(32, false)) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.metadata.getAsset(id);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(asset.data);
  }
}

import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Matches, MaxLength } from 'class-validator';
import type { Hex } from 'viem';
import { AuthService, type SessionToken } from './auth.service.js';

class VerifySiweDto {
  @ApiProperty({ description: 'EIP-4361 message that was signed' })
  @IsString()
  @MaxLength(2048)
  message!: string;

  @ApiProperty({ description: 'Wallet signature of the message', example: '0x...' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]+$/)
  @MaxLength(20_000)
  signature!: Hex;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('nonce')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get a single-use SIWE nonce (valid for 10 minutes)' })
  @ApiOkResponse({ schema: { properties: { nonce: { type: 'string' } } } })
  async nonce(): Promise<{ nonce: string }> {
    return { nonce: await this.auth.createNonce() };
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a signed SIWE message and get a session token' })
  @ApiOkResponse({
    schema: {
      properties: {
        token: { type: 'string' },
        address: { type: 'string' },
        expiresIn: { type: 'number' },
      },
    },
  })
  verify(@Body() body: VerifySiweDto): Promise<SessionToken> {
    return this.auth.verify(body.message, body.signature);
  }
}

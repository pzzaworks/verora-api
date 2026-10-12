import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getAddress, type Hex } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { ChainService } from '../chain/chain.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

export interface SessionPayload {
  sub: string; // lowercase wallet address
}

export interface SessionToken {
  token: string;
  address: string;
  expiresIn: number;
}

/**
 * Sign-In with Ethereum (EIP-4361). Nonces are single-use and stored in the database so sign-in works
 * across API instances. Signatures are verified through the chain client, which also supports
 * smart-contract wallets (ERC-1271 / ERC-6492).
 */
@Injectable()
export class AuthService {
  static readonly SESSION_TTL_SECONDS = 60 * 60;

  private readonly allowedDomains: string[];
  private readonly allowedOrigins: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    private readonly jwt: JwtService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.allowedDomains = config.get('SIWE_DOMAINS', { infer: true });
    this.allowedOrigins = new Set(
      config.get('CORS_ORIGINS', { infer: true }).map((origin) => new URL(origin).origin),
    );
  }

  async createNonce(): Promise<string> {
    const nonce = generateSiweNonce();
    await this.prisma.authNonce.create({
      data: { nonce, expiresAt: new Date(Date.now() + NONCE_TTL_MS) },
    });
    // Opportunistic cleanup keeps the table small without a separate job
    await this.prisma.authNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return nonce;
  }

  async verify(message: string, signature: Hex): Promise<SessionToken> {
    const fields = parseSiweMessage(message);
    const { address, domain, uri, nonce, chainId, issuedAt, expirationTime, notBefore } = fields;

    if (!address || !domain || !uri || !nonce || !chainId) {
      throw new UnauthorizedException('Malformed SIWE message');
    }
    if (this.allowedDomains.length > 0 && !this.allowedDomains.includes(domain)) {
      throw new UnauthorizedException('SIWE domain is not allowed');
    }
    if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(originOf(uri))) {
      throw new UnauthorizedException('SIWE URI is not an allowed origin');
    }
    if (chainId !== this.chain.chain.id) {
      throw new UnauthorizedException('SIWE chain does not match this network');
    }

    const now = Date.now();
    if (
      !issuedAt ||
      now - issuedAt.getTime() > MAX_MESSAGE_AGE_MS ||
      issuedAt.getTime() > now + 60_000
    ) {
      throw new UnauthorizedException('SIWE message is too old or issued in the future');
    }
    if (
      (expirationTime && expirationTime.getTime() <= now) ||
      (notBefore && notBefore.getTime() > now)
    ) {
      throw new UnauthorizedException('SIWE message is not currently valid');
    }

    // Consume the nonce atomically: a replayed message finds nothing to delete
    const consumed = await this.prisma.authNonce.deleteMany({
      where: { nonce, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Unknown or expired nonce');
    }

    const valid = await this.chain.publicClient.verifySiweMessage({
      message,
      signature,
      nonce,
      domain,
    });
    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    const wallet = getAddress(address).toLowerCase();
    const token = await this.jwt.signAsync({ sub: wallet } satisfies SessionPayload);
    return { token, address: wallet, expiresIn: AuthService.SESSION_TTL_SECONDS };
  }
}

/** Origin of a SIWE `uri`, or an empty string when it isn't a valid URL (never an allowed origin) */
function originOf(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return '';
  }
}

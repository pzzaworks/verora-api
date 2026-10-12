import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { verifyMessage, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainService } from '../chain/chain.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';

const DOMAIN = 'app.verora.test';
const CHAIN_ID = 11155111;

describe('AuthService', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonces = new Map<string, Date>();
  let service: AuthService;
  let jwt: JwtService;

  const prisma = {
    authNonce: {
      create: vi.fn(({ data }: { data: { nonce: string; expiresAt: Date } }) => {
        nonces.set(data.nonce, data.expiresAt);
        return Promise.resolve(data);
      }),
      deleteMany: vi.fn(({ where }: { where: { nonce?: string } }) => {
        if (!where.nonce) return Promise.resolve({ count: 0 });
        const existed = nonces.delete(where.nonce);
        return Promise.resolve({ count: existed ? 1 : 0 });
      }),
    },
  };

  const chain = {
    chain: { id: CHAIN_ID },
    publicClient: {
      verifySiweMessage: ({ message, signature }: { message: string; signature: Hex }) =>
        verifyMessage({ address: account.address, message, signature }),
    },
  };

  beforeEach(() => {
    nonces.clear();
    jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: 3600 } });
    const values = new Map<keyof EnvironmentVariables, string[]>([
      ['SIWE_DOMAINS', [DOMAIN]],
      ['CORS_ORIGINS', [`https://${DOMAIN}`]],
    ]);
    const config = {
      get: (key: keyof EnvironmentVariables) => values.get(key),
    } as unknown as ConfigService<EnvironmentVariables, true>;
    service = new AuthService(
      prisma as unknown as PrismaService,
      chain as unknown as ChainService,
      jwt,
      config,
    );
  });

  async function signIn(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
    const nonce = await service.createNonce();
    const message = createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain: DOMAIN,
      nonce,
      uri: `https://${DOMAIN}`,
      version: '1',
      issuedAt: new Date(),
      ...overrides,
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  it('issues a session token for a valid signature', async () => {
    const { message, signature } = await signIn();
    const session = await service.verify(message, signature);

    expect(session.address).toBe(account.address.toLowerCase());
    expect(jwt.verify<{ sub: string }>(session.token).sub).toBe(account.address.toLowerCase());
  });

  it('rejects a replayed nonce', async () => {
    const { message, signature } = await signIn();
    await service.verify(message, signature);
    await expect(service.verify(message, signature)).rejects.toThrow(/nonce/);
  });

  it('rejects foreign domains, other chains, and stale messages', async () => {
    const foreign = await signIn({ domain: 'evil.test' });
    await expect(service.verify(foreign.message, foreign.signature)).rejects.toThrow(/domain/);

    const otherChain = await signIn({ chainId: 1 });
    await expect(service.verify(otherChain.message, otherChain.signature)).rejects.toThrow(/chain/);

    const stale = await signIn({ issuedAt: new Date(Date.now() - 60 * 60 * 1000) });
    await expect(service.verify(stale.message, stale.signature)).rejects.toThrow(/too old/);
  });

  it('rejects a URI whose origin is not an allowed app origin', async () => {
    const foreign = await signIn({ uri: 'https://evil.test/login' });
    await expect(service.verify(foreign.message, foreign.signature)).rejects.toThrow(/URI/);

    const sameOriginPath = await signIn({ uri: `https://${DOMAIN}/agents/new` });
    await expect(
      service.verify(sameOriginPath.message, sameOriginPath.signature),
    ).resolves.toBeDefined();
  });

  it('rejects a signature from another wallet', async () => {
    const { message } = await signIn();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signMessage({ message });
    await expect(service.verify(message, signature)).rejects.toThrow(UnauthorizedException);
  });
});

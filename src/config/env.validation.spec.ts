import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  CHAIN: 'sepolia',
  RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
  AGENT_REGISTRY_ADDRESS: address,
  QUERY_CONSUMER_ADDRESS: address,
  STAKING_POOL_ADDRESS: address,
  REPUTATION_MANAGER_ADDRESS: address,
  PAYMENT_ROUTER_ADDRESS: address,
  JWT_SECRET: 's'.repeat(32),
  PUBLIC_BASE_URL: 'https://api.veroraprotocol.com',
  ORACLE_ENABLED: 'false',
};

describe('validateEnv', () => {
  it('parses a valid configuration with defaults and lists', () => {
    const env = validateEnv({
      ...base,
      CORS_ORIGINS: 'https://a.example, https://b.example',
      START_BLOCK: '42',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(env.START_BLOCK).toBe(42);
    expect(env.CONFIRMATIONS).toBe(3);
    expect(env.ORACLE_ENABLED).toBe(false);
    expect(env.INDEXER_ENABLED).toBe(true);
    expect(env.WORKERS_ENABLED).toBe(true);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it('fails fast on missing or malformed values', () => {
    expect(() => validateEnv({ ...base, QUERY_CONSUMER_ADDRESS: '0x123' })).toThrow(
      /QUERY_CONSUMER_ADDRESS/,
    );
    expect(() => validateEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...base, CHAIN: 'mainnet' })).toThrow(/CHAIN/);
    expect(() => validateEnv({ ...base, CHAIN: 'base-sepolia' })).toThrow(/CHAIN/);
    expect(validateEnv({ ...base, INDEXER_ENABLED: 'false' }).INDEXER_ENABLED).toBe(false);
  });

  it('requires the oracle key when the oracle is enabled', () => {
    expect(() => validateEnv({ ...base, ORACLE_ENABLED: 'true' })).toThrow(/ORACLE_PRIVATE_KEY/);
  });

  it('enforces production safety settings', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://veroraprotocol.com',
      TRUST_PROXY_HOPS: '1',
      SIWE_DOMAINS: 'veroraprotocol.com',
    };
    expect(() => validateEnv({ ...production, ALLOW_PRIVATE_AGENT_ENDPOINTS: 'true' })).toThrow(
      /production/,
    );
    expect(() => validateEnv({ ...production, CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
    expect(() => validateEnv({ ...production, TRUST_PROXY_HOPS: undefined })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
    expect(() => validateEnv({ ...production, TRUST_PROXY_HOPS: '' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => validateEnv({ ...production, TRUST_PROXY_HOPS: '11' })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
    expect(validateEnv(production).TRUST_PROXY_HOPS).toBe(1);
    expect(validateEnv(production).NODE_ENV).toBe('production');
  });
});

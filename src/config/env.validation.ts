import { plainToInstance, Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsBoolean,
  IsEthereumAddress,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** `foundry` is local Anvil for development; `sepolia` is Ethereum Sepolia (chain 11155111) */
export const SUPPORTED_CHAINS = ['foundry', 'sepolia'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';
const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : value;

/**
 * Environment schema. The API refuses to start when anything required is missing or malformed,
 * instead of silently running with partial blockchain configuration.
 */
export class EnvironmentVariables {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  @Transform(({ value }) => Number(value))
  PORT = 4100;

  @IsString()
  @Matches(/^postgres(ql)?:\/\//)
  DATABASE_URL!: string;

  @IsIn(SUPPORTED_CHAINS)
  CHAIN!: SupportedChain;

  /**
   * Comma-separated HTTP(S) endpoints, used one at a time and failed over in order when the active one
   * stops answering (see chain/failover-transport.ts), or a single WS(S) endpoint
   */
  @Transform(toList)
  @ArrayNotEmpty()
  @IsUrl({ require_tld: false, protocols: ['http', 'https', 'ws', 'wss'] }, { each: true })
  RPC_URL!: string[];

  @IsEthereumAddress()
  AGENT_REGISTRY_ADDRESS!: string;

  @IsEthereumAddress()
  QUERY_CONSUMER_ADDRESS!: string;

  @IsEthereumAddress()
  STAKING_POOL_ADDRESS!: string;

  @IsEthereumAddress()
  REPUTATION_MANAGER_ADDRESS!: string;

  @IsEthereumAddress()
  PAYMENT_ROUTER_ADDRESS!: string;

  /** Block the contracts were deployed at; the indexer starts here on a fresh database */
  @IsInt()
  @Min(0)
  @Transform(({ value }) => Number(value))
  START_BLOCK = 0;

  /** Extra blocks to stay behind the chain's `safe` head before indexing, as an additional reorg margin */
  @IsInt()
  @Min(0)
  @Max(256)
  @Transform(({ value }) => Number(value))
  CONFIRMATIONS = 3;

  /** Runs the chain indexer. Exactly one instance per database should index. */
  @IsBoolean()
  @Transform(toBoolean)
  INDEXER_ENABLED = true;

  /** Runs background workers (agent metadata and health, metadata garbage collection). One instance per database. */
  @IsBoolean()
  @Transform(toBoolean)
  WORKERS_ENABLED = true;

  @IsBoolean()
  @Transform(toBoolean)
  ORACLE_ENABLED = true;

  /** Key of the authorized finalizer. Only needs gas; it must NOT be the contract owner. */
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  ORACLE_PRIVATE_KEY?: string;

  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;

  /** Public base URL of this API, used to build metadata and asset URLs */
  @IsUrl({ require_tld: false, require_protocol: true })
  PUBLIC_BASE_URL!: string;

  /** Browser origins allowed by CORS */
  @Transform(toList)
  @IsUrl({ require_tld: false, require_protocol: true }, { each: true })
  CORS_ORIGINS: string[] = [];

  /** Hostnames accepted in SIWE messages (host[:port] of the app) */
  @Transform(toList)
  @IsString({ each: true })
  SIWE_DOMAINS: string[] = [];

  @IsBoolean()
  @Transform(toBoolean)
  SWAGGER_ENABLED = false;

  /** Development only: lets the oracle and health checks call agents on private/loopback addresses */
  @IsBoolean()
  @Transform(toBoolean)
  ALLOW_PRIVATE_AGENT_ENDPOINTS = false;

  /**
   * Number of reverse proxies in front of the API, for correct client IPs in rate limiting
   * (1 behind a single proxy such as Coolify's Traefik). Must be set explicitly in production.
   */
  @IsInt()
  @Min(0)
  @Max(10)
  @Transform(({ value }) => Number(value))
  TRUST_PROXY_HOPS = 0;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, { exposeDefaultValues: true });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors.map(
      (error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
    );
    throw new Error(`Invalid environment configuration:\n  ${details.join('\n  ')}`);
  }

  if (validated.ORACLE_ENABLED && !validated.ORACLE_PRIVATE_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  ORACLE_PRIVATE_KEY is required when ORACLE_ENABLED=true',
    );
  }

  if (validated.NODE_ENV === 'production') {
    if (validated.ALLOW_PRIVATE_AGENT_ENDPOINTS) {
      throw new Error(
        'Invalid environment configuration:\n  ALLOW_PRIVATE_AGENT_ENDPOINTS must be false in production',
      );
    }
    if (validated.CORS_ORIGINS.length === 0 || validated.SIWE_DOMAINS.length === 0) {
      throw new Error(
        'Invalid environment configuration:\n  CORS_ORIGINS and SIWE_DOMAINS are required in production',
      );
    }
    // A wrong hop count either rate-limits every client as the proxy's IP (too low) or lets clients
    // spoof X-Forwarded-For (too high), so production must state it rather than inherit the default
    const hops = config.TRUST_PROXY_HOPS;
    if (hops === undefined || (typeof hops === 'string' && hops.trim() === '')) {
      throw new Error(
        'Invalid environment configuration:\n  TRUST_PROXY_HOPS must be set explicitly in production ' +
          '(0 when directly exposed, 1 behind a single reverse proxy such as Traefik)',
      );
    }
  }

  return validated;
}

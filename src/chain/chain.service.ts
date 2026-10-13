import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  webSocket,
  type Account,
  type Address,
  type BlockTag,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';
import { failover } from './failover-transport.js';
import type { EnvironmentVariables, SupportedChain } from '../config/env.validation.js';

interface ChainProfile {
  chain: Chain;
  /** Head the indexer follows before subtracting `CONFIRMATIONS` */
  headTag: Extract<BlockTag, 'latest' | 'safe'>;
}

const CHAINS: Record<SupportedChain, ChainProfile> = {
  // Anvil reports `safe` as latest minus one epoch (32 blocks) and only mines on demand, so local
  // development follows latest and relies on CONFIRMATIONS alone
  foundry: { chain: foundry, headTag: 'latest' },
  // `safe` (justified, ~1-2 epochs behind latest) instead of `finalized` (~2 epochs more): reorgs
  // past the safe head need a consensus failure, and the indexer stays minutes rather than ~13 min behind
  sepolia: { chain: sepolia, headTag: 'safe' },
};

export interface ContractAddresses {
  agentRegistry: Address;
  queryConsumer: Address;
  stakingPool: Address;
  reputationManager: Address;
  paymentRouter: Address;
}

/**
 * Single source of chain configuration: the public client, contract addresses, and the oracle
 * signer. The signer uses viem's nonce manager so concurrent transactions don't collide.
 */
@Injectable()
export class ChainService {
  private readonly logger = new Logger(ChainService.name);

  readonly chain: Chain;
  private readonly headTag: ChainProfile['headTag'];
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly addresses: ContractAddresses;
  readonly startBlock: bigint;
  readonly confirmations: bigint;

  private readonly walletClient: WalletClient<Transport, Chain, Account> | null;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const profile = CHAINS[config.get('CHAIN', { infer: true })];
    this.chain = profile.chain;
    this.headTag = profile.headTag;

    const rpcUrls = config.get('RPC_URL', { infer: true });
    const websocket = rpcUrls.some((url) => url.startsWith('ws'));
    if (websocket && rpcUrls.length > 1) {
      throw new Error('RPC_URL takes either one WS(S) endpoint or a list of HTTP(S) endpoints');
    }
    const transport = websocket
      ? webSocket(rpcUrls[0])
      : failover(rpcUrls, {
          timeout: 15_000,
          onSwitch: (from, to, reason) =>
            this.logger.warn(`RPC ${from} failed (${reason}), switched to ${to}`),
        });

    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.addresses = {
      agentRegistry: config.get('AGENT_REGISTRY_ADDRESS', { infer: true }),
      queryConsumer: config.get('QUERY_CONSUMER_ADDRESS', { infer: true }),
      stakingPool: config.get('STAKING_POOL_ADDRESS', { infer: true }),
      reputationManager: config.get('REPUTATION_MANAGER_ADDRESS', { infer: true }),
      paymentRouter: config.get('PAYMENT_ROUTER_ADDRESS', { infer: true }),
    };
    this.startBlock = BigInt(config.get('START_BLOCK', { infer: true }));
    this.confirmations = BigInt(config.get('CONFIRMATIONS', { infer: true }));

    const oracleKey = config.get('ORACLE_PRIVATE_KEY', { infer: true });
    if (config.get('ORACLE_ENABLED', { infer: true }) && oracleKey) {
      const account = privateKeyToAccount(oracleKey as `0x${string}`, { nonceManager });
      this.walletClient = createWalletClient({ account, chain: this.chain, transport });
      this.logger.log(`Oracle signer ${account.address} on ${this.chain.name}`);
    } else {
      this.walletClient = null;
    }
  }

  /** Oracle wallet; throws when the oracle is disabled so callers can't silently skip writes */
  get oracleWallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) throw new Error('Oracle signer is not configured');
    return this.walletClient;
  }

  get hasOracleSigner(): boolean {
    return this.walletClient !== null;
  }

  /** Latest block that is considered safe to index: the chain profile's head minus `CONFIRMATIONS` */
  async getSafeBlockNumber(): Promise<bigint> {
    const { number: head } = await this.publicClient.getBlock({ blockTag: this.headTag });
    return head > this.confirmations ? head - this.confirmations : 0n;
  }
}

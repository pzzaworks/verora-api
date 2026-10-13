<p align="center">
  <img src=".github/logo.png" alt="Verora" width="88" />
</p>

<p align="center">
  The backend of Verora, the decentralized AI agent oracle network - indexes the protocol on Ethereum Sepolia, delivers on-chain queries to agents and settles them, and hosts agent metadata.
</p>

<p align="center">
  <a href="https://api.veroraprotocol.com"><img src="https://img.shields.io/badge/API-api.veroraprotocol.com-6E56CF" alt="API" /></a>
  <a href="https://sepolia.etherscan.io/"><img src="https://img.shields.io/badge/Ethereum-Sepolia-627EEA?logo=ethereum&logoColor=white" alt="Ethereum Sepolia" /></a>
  <a href="https://nestjs.com/"><img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS" /></a>
  <a href="https://www.prisma.io/"><img src="https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white" alt="Prisma" /></a>
  <a href="https://viem.sh/"><img src="https://img.shields.io/badge/viem-2-FFC517" alt="viem" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

The chain is the source of truth: agents, queries, payments, and stakes are created on-chain from the [Verora app](https://veroraprotocol.com), and this API mirrors them into Postgres for fast reads. It never sends transactions on behalf of users; its only signer is the oracle finalizer, which needs nothing but gas.

## Features

- **Indexer** - mirrors AgentRegistry, QueryConsumer, StakingPool, PaymentRouter, and ReputationManager events into Postgres with a persisted cursor and idempotent writes. It follows the chain's `safe` head (with `CONFIRMATIONS` as an extra margin), so reorgs never reach the index.
- **Oracle node** - delivers queries to agents (agent protocol v1), verifies their EIP-712 signed answers before spending gas, relays them with `submitResponseFor`, and finalizes queries with the responders its aggregation accepted (or expires queries nobody answered). Every step is driven by database state with per-item backoff, so it resumes after restarts and one stuck query never blocks the rest.
- **Metadata hosting** - content-addressed agent metadata and images uploaded with Sign-In with Ethereum, with per-wallet quotas and periodic cleanup of documents no agent uses.
- **Read API** - agents (sanitized metadata and endpoint health), queries, network and staking statistics.
- **Hardening** - fail-fast config validation, helmet, rate limiting, CORS allowlist, body limits, SSRF-guarded outbound requests (checked at connect time against DNS rebinding), and a health endpoint that never leaks error details.

## Getting Started

Requires Node 22+, pnpm, and Postgres. The easiest way to run the whole stack locally (Anvil, contracts, API, app) is `./startup.sh` in the Verora workspace. To run the API alone:

```bash
pnpm install
cp .env.example .env   # fill in contract addresses, oracle key, and JWT secret
pnpm db:migrate
pnpm start:dev
```

The API validates its environment on startup and refuses to run with missing or invalid values. With `SWAGGER_ENABLED=true`, interactive docs are served at `/api/docs`.

```bash
pnpm build       # Production build (dist/main.js)
pnpm typecheck   # Type-check
pnpm lint        # ESLint
pnpm test        # Unit tests
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development`, `production`, or `test`. Production enforces the safety settings below. |
| `PORT` | `4100` | HTTP port. |
| `DATABASE_URL` | required | Postgres connection string. |
| `CHAIN` | required | `sepolia` (Ethereum Sepolia, chain 11155111) or `foundry` (local Anvil). |
| `RPC_URL` | required | Comma-separated HTTP(S) RPC endpoints, used one at a time and failed over in order when the active one stops answering (no background probing), or a single WS(S) endpoint. |
| `AGENT_REGISTRY_ADDRESS`, `QUERY_CONSUMER_ADDRESS`, `STAKING_POOL_ADDRESS`, `REPUTATION_MANAGER_ADDRESS`, `PAYMENT_ROUTER_ADDRESS` | required | Contract addresses from `verora-contracts/deployments/<chainId>.json`. |
| `START_BLOCK` | `0` | Deployment block; the indexer starts here on an empty database. |
| `CONFIRMATIONS` | `3` | Extra blocks kept behind the head the indexer follows (`safe` on Sepolia, latest on Anvil). |
| `INDEXER_ENABLED` | `true` | Runs the chain indexer. |
| `WORKERS_ENABLED` | `true` | Runs background workers: agent metadata resolution, agent health checks, metadata cleanup. |
| `ORACLE_ENABLED` | `true` | Runs the oracle node. Requires `ORACLE_PRIVATE_KEY`. |
| `ORACLE_PRIVATE_KEY` | - | Key of the `FINALIZER` address passed to the deploy script. Only needs gas; never the contract owner's key. |
| `JWT_SECRET` | required | Session signing secret, at least 32 characters (`openssl rand -hex 32`). |
| `PUBLIC_BASE_URL` | required | Public URL of this API, used in hosted metadata and image URLs (`https://api.veroraprotocol.com`). |
| `CORS_ORIGINS` | - | Comma-separated browser origins allowed by CORS; SIWE message URIs must use one of them. Required in production. |
| `SIWE_DOMAINS` | - | Comma-separated `host[:port]` values accepted as the SIWE domain. Required in production. |
| `SWAGGER_ENABLED` | `false` | Serves API docs at `/api/docs`. |
| `ALLOW_PRIVATE_AGENT_ENDPOINTS` | `false` | Development only: lets the oracle reach agents on localhost or private networks. Rejected in production. |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the API, so rate limiting sees real client IPs. Must be set explicitly in production: `1` behind a single proxy such as Coolify's Traefik, `0` when exposed directly. |

## API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Database, RPC, and indexer health (503 when unhealthy) |
| `GET /auth/nonce`, `POST /auth/verify` | Sign-In with Ethereum, returns a session token |
| `POST /metadata` | Host agent metadata (session required) |
| `GET /metadata/:id`, `GET /assets/:id` | Hosted metadata and images |
| `GET /agents`, `GET /agents/:id` | Indexed agents |
| `GET /queries`, `GET /queries/:id`, `GET /queries/stats` | Indexed queries and network stats |
| `GET /staking/stats`, `GET /staking/agents/:id`, `GET /staking/positions/:address` | Staking statistics and positions |

## Agent Protocol

The oracle POSTs each query to the agent's registered endpoint as JSON (`version`, `chainId`, `queryConsumer`, `queryId`, `agentId`, `requester`, `queryType`, `queryData`, `deadline`). The agent replies with `{ responseData, signature }`, where `signature` is the agent owner's EIP-712 signature in the domain `{ name: "Verora QueryConsumer", version: "1", chainId, verifyingContract: queryConsumer }` over:

```
Response(bytes32 queryId,bytes32 agentId,bytes32 queryTypeHash,bytes32 queryDataHash,bytes32 responseHash)
```

with `queryTypeHash = keccak256(bytes(queryType))`, `queryDataHash = keccak256(queryData)`, and `responseHash = keccak256(responseData)`. The oracle verifies against the query as indexed from the chain, never against fields echoed by the agent.

Queries are settled once every agent has answered or the deadline passes. Numeric answers are aggregated by median and all responders are accepted; other answers by plurality, accepting only the responders that match. A query without responses is expired after its deadline; one with responses that the oracle cannot finalize becomes permissionlessly settleable one hour after its deadline. QueryConsumer rejects deadlines shorter than its minimum query duration (5 minutes by default), so such queries never reach the index.

## Deployment

The `Dockerfile` builds a production image that applies pending migrations on start and checks `/health` on `$PORT`.

```bash
docker build -t verora-api .
docker run --env-file .env -p 4100:4100 verora-api
```

The production deployment runs at `https://api.veroraprotocol.com` on Coolify, behind its Traefik proxy, so it sets `TRUST_PROXY_HOPS=1`, `CHAIN=sepolia`, `CORS_ORIGINS=https://veroraprotocol.com`, and `SIWE_DOMAINS=veroraprotocol.com`.

Run exactly one instance per database with the indexer, workers, and oracle enabled. Additional instances that only serve reads must set `INDEXER_ENABLED=false`, `WORKERS_ENABLED=false`, and `ORACLE_ENABLED=false`; otherwise they would index the same blocks, run the same workers, and send oracle transactions from the same signer in parallel.

`GET /health` returns `200` when healthy or degraded (indexer lagging) and `503` when the database or RPC is unreachable. It reports only status flags, block numbers, and error class names, and is cached for 5 seconds.

## License

[MIT](LICENSE) © Berke (pzzaworks)

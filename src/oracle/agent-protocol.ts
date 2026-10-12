import { isHex, keccak256, size, toBytes, type Address, type Hex } from 'viem';

/**
 * Verora agent protocol v1.
 *
 * The oracle POSTs an `AgentQueryRequest` as JSON to the agent's registered endpoint. The agent answers
 * with an `AgentQueryResponse`: the raw response bytes plus an EIP-712 signature by the agent owner over
 * `Response(queryId, agentId, keccak256(queryType), keccak256(queryData), keccak256(responseData))` in
 * the QueryConsumer domain. Binding the request data means a signature can only answer the exact query
 * it was produced for. The oracle verifies the signature and relays it with `submitResponseFor`, so the
 * agent never needs gas.
 */
export const AGENT_PROTOCOL_VERSION = 1;
export const MAX_RESPONSE_BYTES = 16_384;

export interface AgentQueryRequest {
  version: typeof AGENT_PROTOCOL_VERSION;
  chainId: number;
  queryConsumer: Address;
  queryId: Hex;
  agentId: Hex;
  requester: Address;
  queryType: string;
  queryData: Hex;
  deadline: number;
}

export interface AgentQueryResponse {
  responseData: Hex;
  signature: Hex;
}

export const responseTypes = {
  Response: [
    { name: 'queryId', type: 'bytes32' },
    { name: 'agentId', type: 'bytes32' },
    { name: 'queryTypeHash', type: 'bytes32' },
    { name: 'queryDataHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
  ],
} as const;

export function responseDomain(chainId: number, queryConsumer: Address) {
  return {
    name: 'Verora QueryConsumer',
    version: '1',
    chainId,
    verifyingContract: queryConsumer,
  } as const;
}

/** The query fields as recorded on-chain; the oracle takes them from the index, never from the agent */
export interface SignedQuery {
  queryId: Hex;
  queryType: string;
  queryData: Hex;
}

export function responseMessage(query: SignedQuery, agentId: Hex, responseData: Hex) {
  return {
    queryId: query.queryId,
    agentId,
    queryTypeHash: keccak256(toBytes(query.queryType)),
    queryDataHash: keccak256(query.queryData),
    responseHash: keccak256(responseData),
  } as const;
}

export class InvalidAgentResponseError extends Error {}

/** Validates the untrusted JSON body returned by an agent */
export function parseAgentResponse(body: unknown): AgentQueryResponse {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidAgentResponseError('Agent response is not a JSON object');
  }
  const { responseData, signature } = body as Record<string, unknown>;

  if (typeof responseData !== 'string' || !isHex(responseData, { strict: true })) {
    throw new InvalidAgentResponseError('responseData must be a 0x-prefixed hex string');
  }
  if (size(responseData) > MAX_RESPONSE_BYTES) {
    throw new InvalidAgentResponseError(`responseData exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (
    typeof signature !== 'string' ||
    !isHex(signature, { strict: true }) ||
    size(signature) === 0 ||
    size(signature) > 4096
  ) {
    throw new InvalidAgentResponseError('signature must be a 0x-prefixed hex signature');
  }
  return { responseData, signature };
}

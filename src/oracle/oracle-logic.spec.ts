import {
  encodeAbiParameters,
  hashStruct,
  keccak256,
  toBytes,
  verifyTypedData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { aggregateResponses } from './aggregation.js';
import {
  InvalidAgentResponseError,
  parseAgentResponse,
  responseDomain,
  responseMessage,
  responseTypes,
} from './agent-protocol.js';

const int = (value: bigint) => encodeAbiParameters([{ type: 'int256' }], [value]);
const pair = (a: bigint, b: bigint) =>
  encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [a, b]);

describe('aggregateResponses', () => {
  it('returns empty with no responses, and accepts every encrypted response', () => {
    expect(aggregateResponses('plaintext', [])).toEqual({ result: '0x', accepted: [] });
    expect(aggregateResponses('encrypted', [int(1n), '0xabcd'])).toEqual({
      result: '0x',
      accepted: [0, 1],
    });
  });

  it('returns the single response as-is', () => {
    expect(aggregateResponses('price_feed', ['0x1234'])).toEqual({
      result: '0x1234',
      accepted: [0],
    });
  });

  it('takes the per-word median of numeric responses and accepts all of them', () => {
    expect(aggregateResponses('price', [int(100n), int(-5n), int(300n)])).toEqual({
      result: int(100n),
      accepted: [0, 1, 2],
    });
    expect(aggregateResponses('price', [int(4n), int(1n), int(3n), int(2n)]).result).toBe(int(2n));
    expect(
      aggregateResponses('sentiment', [pair(10n, 90n), pair(-20n, 50n), pair(30n, 70n)]).result,
    ).toBe(pair(10n, 70n));
  });

  it('accepts every responder when the top answers tie, keeping the earliest as the result', () => {
    expect(aggregateResponses('text', ['0xaa', '0xbbbb', '0xbbbb', '0xAA', '0xcc'])).toEqual({
      result: '0xaa',
      accepted: [0, 1, 2, 3, 4],
    });
  });

  it('uses the most common non-numeric response and accepts only matching ones', () => {
    expect(aggregateResponses('text', ['0xaa', '0xBBBB', '0xbbbb'])).toEqual({
      result: '0xBBBB',
      accepted: [1, 2],
    });
    expect(aggregateResponses('text', ['0xaa', '0xbbbb'])).toEqual({
      result: '0xaa',
      accepted: [0, 1],
    });
  });
});

describe('agent protocol', () => {
  const signer = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const queryConsumer = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';
  const queryId: Hex = `0x${'11'.repeat(32)}`;
  const agentId: Hex = `0x${'22'.repeat(32)}`;

  it('validates the response shape and size', () => {
    expect(() => parseAgentResponse('nope')).toThrow(InvalidAgentResponseError);
    expect(() => parseAgentResponse({ responseData: 'abc', signature: '0x00' })).toThrow(
      InvalidAgentResponseError,
    );
    expect(() =>
      parseAgentResponse({ responseData: `0x${'00'.repeat(16_385)}`, signature: '0x00' }),
    ).toThrow(/exceeds/);
    expect(() => parseAgentResponse({ responseData: '0x01', signature: '0x' })).toThrow(
      InvalidAgentResponseError,
    );
  });

  const query = { queryId, queryType: 'price', queryData: '0xc0ffee' as Hex };

  it('hashes the Response struct exactly like QueryConsumer', () => {
    const responseData = int(42n);
    const typeHash = keccak256(
      toBytes(
        'Response(bytes32 queryId,bytes32 agentId,bytes32 queryTypeHash,bytes32 queryDataHash,bytes32 responseHash)',
      ),
    );
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
        ],
        [
          typeHash,
          queryId,
          agentId,
          keccak256(toBytes('price')),
          keccak256('0xc0ffee'),
          keccak256(responseData),
        ],
      ),
    );

    expect(
      hashStruct({
        data: responseMessage(query, agentId, responseData),
        primaryType: 'Response',
        types: responseTypes,
      }),
    ).toBe(expected);
  });

  it('produces signatures that verify only for the signed query and response', async () => {
    const domain = responseDomain(11155111, queryConsumer);
    const responseData = int(42n);
    const signature = await signer.signTypedData({
      domain,
      types: responseTypes,
      primaryType: 'Response',
      message: responseMessage(query, agentId, responseData),
    });

    const parsed = parseAgentResponse({ responseData, signature });
    const verify = (signed: typeof query, data: Hex) =>
      verifyTypedData({
        address: signer.address,
        domain,
        types: responseTypes,
        primaryType: 'Response',
        message: responseMessage(signed, agentId, data),
        signature: parsed.signature,
      });

    expect(await verify(query, responseData)).toBe(true);
    expect(await verify(query, int(43n))).toBe(false);
    // The same answer can't be replayed for a query with other request data
    expect(await verify({ ...query, queryType: 'text' }, responseData)).toBe(false);
    expect(await verify({ ...query, queryData: '0xc0ffef' }, responseData)).toBe(false);
  });
});

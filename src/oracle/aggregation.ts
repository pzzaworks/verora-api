import { concat, hexToBigInt, numberToHex, size, slice, type Hex } from 'viem';

const WORD_BYTES = 32;
const MAX_NUMERIC_WORDS = 8;

export interface Aggregation {
  /** The on-chain aggregated result */
  result: Hex;
  /**
   * Indexes (into the input array) of the responses the result accepts. Accepted responders are paid
   * and credited by `finalizeQuery`; the rest are recorded as failures. Empty means nothing was usable.
   */
  accepted: number[];
}

/**
 * Deterministically aggregates agent responses into the on-chain result.
 *
 * - `encrypted` queries: every response is encrypted for the requester, so there is nothing to
 *   aggregate or compare; the result is empty, every response is accepted, and clients read the
 *   individual responses.
 * - Numeric responses (all the same length, 1-8 ABI words): element-wise median of the words read as
 *   int256. Even counts use the lower median rather than averaging, so every word of the result is a
 *   word some agent submitted. Each word is chosen independently, so a multi-word result can combine
 *   words from different responses and need not equal any single submitted response. No outliers are
 *   excluded, so every response is accepted.
 * - Anything else: the most common exact response. With a strict winner only the responses that
 *   match it are accepted. When answers tie for the top count, the earliest of them is the result and
 *   every response is accepted, so nobody is penalized for an arbitrary tie-break.
 */
export function aggregateResponses(queryType: string, responses: Hex[]): Aggregation {
  const all = responses.map((_, index) => index);
  if (responses.length === 0) return { result: '0x', accepted: [] };
  if (queryType === 'encrypted') return { result: '0x', accepted: all };
  if (responses.length === 1) return { result: responses[0], accepted: all };

  const lengths = new Set(responses.map((response) => size(response)));
  const [length] = lengths;
  if (
    lengths.size === 1 &&
    length > 0 &&
    length % WORD_BYTES === 0 &&
    length / WORD_BYTES <= MAX_NUMERIC_WORDS
  ) {
    return { result: medianByWord(responses, length / WORD_BYTES), accepted: all };
  }

  const { result, strict } = mostCommon(responses);
  // Without a strict winner the result is an arbitrary (earliest) pick, so no responder is penalized
  if (!strict) return { result, accepted: all };
  const key = result.toLowerCase();
  return {
    result,
    accepted: responses.flatMap((response, index) =>
      response.toLowerCase() === key ? [index] : [],
    ),
  };
}

function medianByWord(responses: Hex[], wordCount: number): Hex {
  const words: Hex[] = [];
  for (let index = 0; index < wordCount; index++) {
    const values = responses
      .map((response) =>
        hexToBigInt(slice(response, index * WORD_BYTES, (index + 1) * WORD_BYTES), {
          signed: true,
        }),
      )
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const median = values[Math.floor((values.length - 1) / 2)];
    words.push(numberToHex(median, { size: WORD_BYTES, signed: true }));
  }
  return concat(words);
}

/** The most common response (earliest on ties), and whether it strictly outnumbers every other answer */
function mostCommon(responses: Hex[]): { result: Hex; strict: boolean } {
  const counts = new Map<string, number>();
  for (const response of responses) {
    const key = response.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = responses[0];
  let bestCount = 0;
  for (const response of responses) {
    const count = counts.get(response.toLowerCase()) ?? 0;
    if (count > bestCount) {
      best = response;
      bestCount = count;
    }
  }
  const topAnswers = [...counts.values()].filter((count) => count === bestCount).length;
  return { result: best, strict: topAnswers === 1 };
}

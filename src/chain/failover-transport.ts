import {
  BaseError,
  createTransport,
  http,
  HttpRequestError,
  shouldThrow,
  type EIP1193RequestFn,
  type Transport,
} from 'viem';

export interface FailoverOptions {
  /** Per-request timeout for each endpoint */
  timeout: number;
  /** Called when the active endpoint changes; receives hosts only, never full URLs (they can carry keys) */
  onSwitch?: (from: string, to: string, reason: string) => void;
}

/**
 * Sticky failover over several HTTP RPC endpoints.
 *
 * Every request goes to the active endpoint. Only when it fails to answer (network error, timeout,
 * rate limit, unsupported range...) is the request retried on the next endpoint, which then stays
 * active. Endpoints are never pinged in the background, so a failing one costs nothing until rotation
 * comes back to it. Errors that are about the request itself (execution reverts, rejected
 * transactions) are thrown as they are instead of trying another endpoint.
 *
 * Sticking to one endpoint also keeps consecutive reads on the same view of the chain, unlike
 * spreading requests over providers that can be a block apart.
 */
export function failover(urls: readonly string[], options: FailoverOptions): Transport {
  if (urls.length === 0) throw new Error('failover needs at least one RPC URL');
  const endpoints = urls.map((url) => ({
    host: new URL(url).host,
    transport: http(url, { timeout: options.timeout, retryCount: 0 }),
  }));

  return ({ chain, pollingInterval, timeout }) => {
    const clients = endpoints.map(({ host, transport }) => ({
      host,
      request: transport({ chain, pollingInterval, timeout, retryCount: 0 }).request,
    }));
    let active = clients[0];

    const request = (async ({ method, params }) => {
      const start = clients.indexOf(active);
      const rotation = [...clients.slice(start), ...clients.slice(0, start)];
      let lastError: unknown;
      for (const client of rotation) {
        try {
          const response: unknown = await client.request({ method, params });
          if (client !== active) {
            options.onSwitch?.(active.host, client.host, describe(lastError));
            active = client;
          }
          return response;
        } catch (error) {
          if (error instanceof Error && shouldThrow(error)) throw error;
          lastError = error;
        }
      }
      throw lastError;
    }) as EIP1193RequestFn;

    return createTransport(
      {
        key: 'failover',
        name: 'Failover',
        type: 'failover',
        request,
        // One more pass after a full rotation failed, to ride out a short outage of every endpoint
        retryCount: 1,
      },
      { activeHost: () => active.host },
    );
  };
}

/** Short reason for a failed endpoint, with the HTTP status when there is one (never the URL) */
function describe(error: unknown): string {
  if (error instanceof BaseError) {
    const http = error.walk((cause) => cause instanceof HttpRequestError);
    const status = http instanceof HttpRequestError ? http.status : undefined;
    if (status) return `HTTP ${status}: ${error.shortMessage}`;
    // Network-level failures carry the cause (connection reset, DNS, TLS) in `details`
    return error.details ? `${error.shortMessage} (${error.details})` : error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

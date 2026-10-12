import { BaseError } from 'viem';

/**
 * Log-safe error text. viem's full `message` includes request details such as the RPC URL (which can
 * carry a provider API key) and the request body, so only its `shortMessage` is used.
 */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Error class name only, for public status output that must not carry any message text */
export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Public, sanitized agent metadata. Anything outside these fields is dropped. */
export interface AgentMetadata {
  name?: string;
  description?: string;
  image?: string;
  banner?: string;
  publicKey?: string;
  website?: string;
}

type MetadataField = keyof AgentMetadata;

const FIELD_LIMITS = new Map<MetadataField, number>([
  ['name', 64],
  ['description', 1000],
  ['image', 512],
  ['banner', 512],
  ['publicKey', 44],
  ['website', 256],
]);

const URL_FIELDS = new Set<MetadataField>(['image', 'banner', 'website']);

/**
 * Sanitizes untrusted metadata JSON (from agent-controlled URIs) before it is stored or served.
 * URL fields must be https (or the API's own origin) so the app never renders javascript:/data: links.
 */
export function sanitizeAgentMetadata(raw: unknown, trustedOrigin: string): AgentMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = new Map<string, unknown>(Object.entries(raw as Record<string, unknown>));
  const result = new Map<MetadataField, string>();

  for (const [field, limit] of FIELD_LIMITS) {
    const value = source.get(field);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > limit) continue;

    if (URL_FIELDS.has(field) && !isAllowedUrl(trimmed, trustedOrigin)) continue;
    if (field === 'publicKey' && !/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) continue;

    result.set(field, trimmed);
  }
  return Object.fromEntries(result);
}

function isAllowedUrl(value: string, trustedOrigin: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.origin === trustedOrigin;
  } catch {
    return false;
  }
}

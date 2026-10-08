import { createHash } from 'node:crypto';
import { detectProvider } from '../providers/detect.js';
import type { JsonValue, Provider } from './schema.js';

export type MatchMode = 'strict' | 'loose';
const volatileFields = new Set([
  'user',
  'metadata',
  'stream_options',
  'store',
  'service_tier',
  'request_id',
  'requestId',
  'request-id',
  'x-request-id',
]);

/** Serialize JSON with lexically sorted object keys and original array order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}

/** Remove only request-level transport metadata; preserve nested user content. */
export function normalizeBody(
  provider: Provider,
  endpoint: string,
  body: JsonValue,
  mode: MatchMode,
): JsonValue {
  // v1 has identical rules for all providers/endpoints, including generic paths.
  void provider;
  void endpoint;
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return body;
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) =>
        !volatileFields.has(key) && !(mode === 'loose' && key === 'seed'),
    ),
  );
}

/** Strip query strings and one boundary-delimited provider proxy prefix. */
export function normalizePath(path: string): string {
  return (
    (path.split('?')[0] ?? '').replace(/^\/(?:openai|anthropic)(?=\/|$)/, '') ||
    '/'
  );
}

/** Hash canonical method, upstream path, and normalized body for replay lookup. */
export function matchKey(
  method: string,
  path: string,
  body: JsonValue,
  mode: MatchMode = 'strict',
): string {
  return createHash('sha256')
    .update(canonicalJson(normalizeRequest(method, path, body, mode)))
    .digest('hex');
}

export function normalizeRequest(
  method: string,
  path: string,
  body: JsonValue,
  mode: MatchMode = 'strict',
): JsonValue {
  const endpoint = normalizePath(path);
  return {
    method: method.toUpperCase(),
    path: endpoint,
    body: normalizeBody(detectProvider(path), endpoint, body, mode),
  };
}

import type { JsonValue, SseChunk } from './schema.js';
import { isDeepStrictEqual } from 'node:util';
import { SseParser } from '../proxy/sse.js';

export type RedactPattern = string | RegExp;
const replacement = '[REDACTED]';
const secretProperty =
  /^(api[-_]?key|apikey|x-api-key|secret|client[-_]?secret|password|passwd|access[-_]?token|refresh[-_]?token|auth[-_]?token|authorization|bearer)$/i;
const allowedHeaders = new Set([
  'content-type',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'x-request-id',
  'request-id',
  'retry-after',
]);

/** Split comma-separated TAPEDIFF_REDACT patterns without reading the environment. */
export function parseRedactPatterns(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((pattern) => pattern.trim())
      .filter(Boolean) ?? []
  );
}

function compilePatterns(patterns: readonly RedactPattern[]): RegExp[] {
  const result = [
    /sk-(?:ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{16,})/g,
    /Bearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi,
  ];
  for (const pattern of patterns) {
    try {
      const source = typeof pattern === 'string' ? pattern : pattern.source;
      if (!source) continue;
      const flags =
        typeof pattern === 'string'
          ? 'g'
          : `${pattern.flags.replace(/[gy]/g, '')}g`;
      result.push(new RegExp(source, flags));
    } catch {
      // Malformed optional regexes must not disable mandatory secret scrubbing.
    }
  }
  return result;
}

function redactString(value: string, patterns: readonly RegExp[]): string {
  for (const pattern of patterns) value = value.replace(pattern, replacement);
  return value;
}

/** Copy JSON-like input, scrubbing strings and keys; unsupported values become null.
 * Iterative traversal avoids stack overflow. Accessors are not invoked and cycles
 * or repeated object references become "[Circular]". Custom regexes are trusted.
 */
export function redactBody(
  value: unknown,
  extraPatterns: readonly RedactPattern[] = [],
): JsonValue {
  const patterns = compilePatterns(extraPatterns);
  const seen = new WeakSet<object>();
  let output: JsonValue = null;
  const pending: { value: unknown; set: (value: JsonValue) => void }[] = [
    {
      value,
      set: (result) => {
        output = result;
      },
    },
  ];
  while (pending.length) {
    const item = pending.pop()!;
    const input = item.value;
    if (typeof input === 'string') {
      item.set(redactString(input, patterns));
    } else if (input === null || typeof input === 'boolean') {
      item.set(input);
    } else if (typeof input === 'number') {
      item.set(Number.isFinite(input) ? input : null);
    } else if (typeof input !== 'object') {
      item.set(null);
    } else if (seen.has(input)) {
      item.set('[Circular]');
    } else {
      seen.add(input);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const result: JsonValue[] | Record<string, JsonValue> = Array.isArray(
          input,
        )
          ? new Array<JsonValue>(input.length).fill(null)
          : {};
        item.set(result);
        for (const [key, descriptor] of Object.entries(descriptors).reverse()) {
          if (!descriptor.enumerable) continue;
          const cleanKey = redactString(key, patterns);
          pending.push({
            value:
              'value' in descriptor
                ? typeof descriptor.value === 'string' &&
                  secretProperty.test(key)
                  ? replacement
                  : descriptor.value
                : null,
            set: (child) => {
              Object.defineProperty(result, cleanKey, {
                value: child,
                enumerable: true,
                writable: true,
                configurable: true,
              });
            },
          });
        }
      } catch {
        item.set(replacement);
      }
    }
  }
  return output;
}

/** Keep safe protocol headers, lowercased; sensitive names always override the allowlist. */
export function redactHeaders(
  headers: Readonly<Record<string, unknown>>,
  patterns: readonly RedactPattern[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (/key|token|secret/i.test(key)) continue;
    if (!allowedHeaders.has(key) && !key.startsWith('x-ratelimit-')) continue;
    const text = Array.isArray(value)
      ? value
          .filter((part): part is string => typeof part === 'string')
          .join(', ')
      : value;
    if (typeof text === 'string')
      result[key] = redactBody(text, patterns) as string;
  }
  return result;
}

/** Redact whole events, retaining their start timestamps even when lengths change. */
export function redactSse(
  chunks: readonly SseChunk[],
  patterns: readonly RedactPattern[] = [],
): SseChunk[] {
  const parser = new SseParser();
  const frames = parser.push(chunks.map((chunk) => chunk.data).join(''), true);
  let offset = 0;
  let chunkIndex = 0;
  let chunkEnd = chunks[0]?.data.length ?? 0;
  return frames.map((frame) => {
    while (offset >= chunkEnd && chunkIndex < chunks.length - 1) {
      chunkIndex++;
      chunkEnd += chunks[chunkIndex]!.data.length;
    }
    const t = chunks[chunkIndex]?.t ?? 0;
    offset += frame.raw.length;
    // JSON data also needs property-name redaction (e.g. api_key: "short").
    let raw = frame.raw;
    try {
      const body: unknown = JSON.parse(frame.data);
      const clean = redactBody(body, patterns);
      if (!isDeepStrictEqual(clean, body)) {
        let inserted = false;
        raw = raw.replace(/^data(?::[^\r\n]*)?/gm, () => {
          if (inserted) return ': redacted data continuation';
          inserted = true;
          return `data: ${JSON.stringify(clean)}`;
        });
      }
    } catch {
      /* Non-JSON events still receive string redaction. */
    }
    return { t, data: redactBody(raw, patterns) as string };
  });
}

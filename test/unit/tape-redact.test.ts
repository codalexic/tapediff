import { describe, expect, it } from 'vitest';
import {
  parseRedactPatterns,
  redactBody,
  redactHeaders,
  redactSse,
} from '../../src/tape/redact.js';
import type { JsonValue } from '../../src/tape/schema.js';
import { exchange, header } from './tape-fixtures.js';

describe('redaction', () => {
  it('keeps only allowlisted headers, overriding even rate-limit headers with sensitive names', () => {
    expect(
      redactHeaders({
        'Content-Type': 'application/json',
        'Anthropic-Version': '2023-06-01',
        'anthropic-beta': 'beta',
        'openai-beta': 'beta',
        'X-Request-ID': 'req',
        'request-id': 'req2',
        'retry-after': '5',
        'x-ratelimit-remaining-requests': '9',
        Authorization: 'Bearer xyz',
        'X-Api-Key': 'hidden',
        'api-key': 'hidden',
        'openai-organization': 'hidden',
        Cookie: 'hidden',
        'set-cookie': 'hidden',
        'x-ratelimit-tokens': 'hidden',
        'x-ratelimit-secret': 'hidden',
        'x-ratelimit-key': 'hidden',
        'x-other': 'hidden',
        host: 'hidden',
      }),
    ).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'beta',
      'openai-beta': 'beta',
      'x-request-id': 'req',
      'request-id': 'req2',
      'retry-after': '5',
      'x-ratelimit-remaining-requests': '9',
    });
    expect(
      redactHeaders({ 'retry-after': ['1', '2', null], 'content-type': 3 }),
    ).toEqual({ 'retry-after': '1, 2' });
    expect(redactHeaders({ 'x-request-id': 'Bearer xyz' })).toEqual({
      'x-request-id': '[REDACTED]',
    });
  });

  it('scrubs embedded keys and bearer tokens while preserving other text and input', () => {
    const input = {
      a: [
        'before sk-proj-01234567890123456789 after',
        { b: 'sk-ant-api03-abcdefghijklmnop' },
      ],
      c: 'Bearer xyz',
      d: 'bearer abc.def+/=',
    };
    const before = JSON.stringify(input);
    expect(redactBody(input)).toEqual({
      a: ['before [REDACTED] after', { b: '[REDACTED]' }],
      c: '[REDACTED]',
      d: '[REDACTED]',
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(redactBody('sk-abcdefghijklmnop, sk-anotherfakekey0123456789')).toBe(
      '[REDACTED], [REDACTED]',
    );
    expect(redactBody('task-manager sk-short ordinary text')).toBe(
      'task-manager sk-short ordinary text',
    );
    expect(redactBody('sk-ant-short')).toBe('[REDACTED]');
  });

  it('parses environment patterns explicitly, ignores invalid regexes, and does not mutate regex state', () => {
    const patterns = parseRedactPatterns(' ,custom-[0-9]+, [,password=\\w+,');
    expect(patterns).toEqual(['custom-[0-9]+', '[', 'password=\\w+']);
    expect(parseRedactPatterns(undefined)).toEqual([]);
    expect(
      redactBody(
        'custom-123 password=hunter sk-proj-abcdefghijklmnop',
        patterns,
      ),
    ).toBe('[REDACTED] [REDACTED] [REDACTED]');
    const pattern = /private/iy;
    pattern.lastIndex = 5;
    expect(redactBody('PRIVATE private', [pattern, ''])).toBe(
      '[REDACTED] [REDACTED]',
    );
    expect(pattern.lastIndex).toBe(5);
  });

  it('handles odd values, cycles, accessors, hostile proxies, and prototype keys', () => {
    const input: Record<string, unknown> = {
      nothing: undefined,
      number: NaN,
      bigint: 3n,
      symbol: Symbol('x'),
      func: () => 1,
    };
    input.self = input;
    Object.defineProperty(input, 'getter', {
      enumerable: true,
      get: () => {
        throw new Error('must not call');
      },
    });
    expect(redactBody(input)).toEqual({
      nothing: null,
      number: null,
      bigint: null,
      symbol: null,
      func: null,
      self: '[Circular]',
      getter: null,
    });
    expect(
      redactBody(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('bad');
            },
          },
        ),
      ),
    ).toBe('[REDACTED]');
    const json: unknown = JSON.parse(
      '{"__proto__":{"polluted":"sk-proj-abcdefghijklmnop"}}',
    );
    expect(JSON.stringify(redactBody(json))).toBe(
      '{"__proto__":{"polluted":"[REDACTED]"}}',
    );
    expect(
      redactBody({ 'sk-proj-abcdefghijklmnop': true, value: null }),
    ).toEqual({ '[REDACTED]': true, value: null });
    const sparse: unknown[] = [false, 1, Infinity];
    sparse.length = 4;
    sparse.push(null);
    expect(redactBody(sparse)).toEqual([false, 1, null, null, null]);
  });

  it('handles very deep objects and multi-megabyte strings without recursion or truncation', () => {
    let input: unknown = 'Bearer xyz';
    for (let index = 0; index < 20_000; index++) input = { child: input };
    let result = redactBody(input);
    for (let index = 0; index < 20_000; index++)
      result = (result as Record<string, JsonValue>).child!;
    expect(result).toBe('[REDACTED]');
    const padding = 'x'.repeat(2_000_000);
    expect(redactBody(`${padding} sk-ant-api03-${padding} done`)).toBe(
      `${padding} [REDACTED] done`,
    );
  });

  it('redacts secrets split at arbitrary SSE chunk boundaries and preserves timestamps', () => {
    const secret = 'Bearer xyz';
    for (let split = 1; split < secret.length; split++) {
      const result = redactSse([
        { t: 0, data: secret.slice(0, split) },
        { t: 10, data: secret.slice(split) },
      ]);
      expect(result.map((chunk) => chunk.data).join('')).toBe('[REDACTED]');
      expect(result.map((chunk) => chunk.t)).toEqual([0]);
    }
    expect(redactSse([])).toEqual([]);
    expect(redactSse([{ t: 0, data: 'data: safe\n\n' }])).toEqual([
      { t: 0, data: 'data: safe\n\n' },
    ]);
  });

  it('fuzzes nested bodies and mixed-case headers with deterministic injected secrets', () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const mixedCase = (text: string): string =>
      [...text]
        .map((char) => (random() < 0.5 ? char.toUpperCase() : char))
        .join('');
    for (let run = 0; run < 500; run++) {
      const suffix = `${run}abcdefghijklmno0123456789`;
      const secrets = [
        `sk-proj-${suffix}`,
        `sk-ant-api03-${suffix}`,
        `Bearer xyz${suffix}`,
        `custom-${suffix}`,
      ];
      const nested = (depth: number): JsonValue => {
        if (depth === 0 || random() < 0.3)
          return `before ${secrets[Math.floor(random() * secrets.length)]!} after`;
        if (random() < 0.5)
          return [nested(depth - 1), false, null, run, nested(depth - 1)];
        return {
          left: nested(depth - 1),
          right: nested(depth - 1),
          safe: 'safe',
        };
      };
      const headers: Record<string, string> = {};
      for (const name of [
        'authorization',
        'x-api-key',
        'api-key',
        'cookie',
        'openai-organization',
        'x-ratelimit-token',
        'x-ratelimit-secret',
      ]) {
        headers[mixedCase(name)] = secrets[Math.floor(random() * 3)]!;
      }
      headers[mixedCase('x-request-id')] = secrets[0]!;
      headers[mixedCase('content-type')] = 'application/json';
      const body = { random: nested(5), guaranteed: secrets };
      const cleanHeaders = redactHeaders(headers);
      const cleanBody = redactBody(body, ['custom-[A-Za-z0-9]+']);
      const serialized = `${JSON.stringify(header)}\n${JSON.stringify({
        ...exchange,
        request: {
          ...exchange.request,
          headers: cleanHeaders,
          body: cleanBody,
        },
        response: {
          ...exchange.response,
          headers: cleanHeaders,
          body: cleanBody,
        },
      })}\n`;
      for (const secret of secrets) expect(serialized).not.toContain(secret);
      expect(serialized).toContain('application/json');
      expect(serialized).toContain('[REDACTED]');
    }
  });
});

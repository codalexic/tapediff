import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  matchKey,
  normalizeBody,
  normalizePath,
} from '../../src/tape/normalize.js';
import { detectProvider } from '../../src/providers/detect.js';

describe('canonical JSON and replay matching', () => {
  it('sorts nested keys lexically, including numeric keys, without reordering arrays', () => {
    expect(
      canonicalJson({
        z: [false, null, 'x\n'],
        a: { b: 1, a: 2 },
        '2': 2,
        '10': 10,
      }),
    ).toBe('{"10":10,"2":2,"a":{"a":2,"b":1},"z":[false,null,"x\\n"]}');
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('drops all volatile request fields, preserving nested arguments and input immutability', () => {
    const body = {
      model: 'model',
      user: 'u',
      metadata: { a: 1 },
      stream_options: {},
      store: true,
      service_tier: 'auto',
      request_id: 'a',
      requestId: 'b',
      'request-id': 'c',
      'x-request-id': 'd',
      seed: 42,
      messages: [
        {
          role: 'user',
          content: { user: 'keep', metadata: 'keep', seed: 5, id: 'tool-id' },
        },
      ],
    };
    const before = JSON.stringify(body);
    for (const provider of ['openai', 'anthropic', 'unknown'] as const) {
      expect(normalizeBody(provider, '/v1/messages', body, 'strict')).toEqual({
        model: 'model',
        seed: 42,
        messages: body.messages,
      });
      expect(normalizeBody(provider, '/v1/messages', body, 'loose')).toEqual({
        model: 'model',
        messages: body.messages,
      });
    }
    expect(JSON.stringify(body)).toBe(before);
  });

  it.each([null, 'text', true, 42, [1, { metadata: 'keep' }]])(
    'preserves generic JSON bodies: %j',
    (body) => {
      expect(normalizeBody('unknown', '/custom', body, 'strict')).toEqual(body);
    },
  );

  it('hashes the exact canonical request, independent of key ordering and proxy query', () => {
    const expected = createHash('sha256')
      .update('{"body":{"a":1,"b":2},"method":"POST","path":"/v1/messages"}')
      .digest('hex');
    expect(
      matchKey(
        'post',
        '/anthropic/v1/messages?trace=1',
        { b: 2, a: 1 },
        'strict',
      ),
    ).toBe(expected);
    expect(
      matchKey('POST', '/v1/messages', { a: 1, b: 2, user: 'ignored' }),
    ).toBe(expected);
    expect(matchKey('POST', '/openai/v1/messages', { a: 1, b: 2 })).toBe(
      expected,
    );
  });

  it('retains seed in strict mode and drops it only in loose mode', () => {
    expect(matchKey('POST', '/v1/responses', { seed: 1 }, 'strict')).not.toBe(
      matchKey('POST', '/v1/responses', { seed: 2 }, 'strict'),
    );
    expect(matchKey('POST', '/v1/responses', { seed: 1 }, 'loose')).toBe(
      matchKey('POST', '/v1/responses', { seed: 2 }, 'loose'),
    );
    expect(matchKey('POST', '/v1/responses', {})).toBe(
      matchKey('POST', '/v1/responses', {}, 'loose'),
    );
  });

  it('keeps semantic fields, methods, endpoints, and array order distinct', () => {
    const base = matchKey('POST', '/v1/responses', {
      model: 'a',
      input: ['a', 'b'],
    });
    for (const other of [
      matchKey('GET', '/v1/responses', { model: 'a', input: ['a', 'b'] }),
      matchKey('POST', '/v1/messages', { model: 'a', input: ['a', 'b'] }),
      matchKey('POST', '/v1/responses', { model: 'b', input: ['a', 'b'] }),
      matchKey('POST', '/v1/responses', { model: 'a', input: ['b', 'a'] }),
    ])
      expect(other).not.toBe(base);
  });

  it.each([
    ['/openai/v1/responses?x=y', '/v1/responses', 'openai'],
    ['/anthropic/v1/messages?q=1', '/v1/messages', 'anthropic'],
    ['/v1/chat/completions', '/v1/chat/completions', 'openai'],
    ['/v1/responses?test=1', '/v1/responses', 'openai'],
    ['/v1/messages', '/v1/messages', 'anthropic'],
    ['/openai/custom', '/custom', 'openai'],
    ['/anthropic/custom', '/custom', 'anthropic'],
    ['/openai', '/', 'openai'],
    ['/anthropic?x=1', '/', 'anthropic'],
    ['/openaix/v1/responses', '/openaix/v1/responses', 'unknown'],
    ['/anthropicish/v1/messages', '/anthropicish/v1/messages', 'unknown'],
    ['/v1/responses/other', '/v1/responses/other', 'unknown'],
    ['/custom?redirect=/openai', '/custom', 'unknown'],
    ['', '/', 'unknown'],
  ])(
    'normalizes and detects %s at path boundaries',
    (path, normalized, provider) => {
      expect(normalizePath(path)).toBe(normalized);
      expect(detectProvider(path)).toBe(provider);
    },
  );
});

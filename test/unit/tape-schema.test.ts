import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  exchangeSchema,
  parseTapeLine,
  tapeHeaderSchema,
  TAPE_VERSION,
  TapeSyntaxError,
} from '../../src/tape/schema.js';
import { exchange, fixturePath, header } from './tape-fixtures.js';

describe('tape schemas', () => {
  it('round-trips the version 1 header and full exchange', () => {
    expect(TAPE_VERSION).toBe(2);
    expect(parseTapeLine(JSON.stringify(header), 1)).toEqual(header);
    expect(parseTapeLine(JSON.stringify(exchange), 2)).toEqual(exchange);
  });

  it('round-trips raw SSE chunks and fractional timings', () => {
    const line = readFileSync(fixturePath('streaming'), 'utf8').split('\n')[1]!;
    const result = exchangeSchema.parse(parseTapeLine(line, 2));
    expect(result.response.sse).toEqual([
      { t: 0, data: 'event: message_start\ndata: {}\n\n' },
      { t: 12.75, data: 'event: message_stop\ndata: {}\n\n' },
    ]);
    expect(parseTapeLine(JSON.stringify(result), 2)).toEqual(result);
  });

  it('explains newer and older tape versions', () => {
    expect(() =>
      parseTapeLine(JSON.stringify({ ...header, tapediff: 3 }), 1),
    ).toThrow('tape version 3 is newer than this tapediff supports; upgrade');
    expect(() =>
      parseTapeLine(JSON.stringify({ ...header, tapediff: 0 }), 1),
    ).toThrow('tape version 0 is older than this tapediff supports; re-record');
    expect(() =>
      parseTapeLine(JSON.stringify({ ...header, tapediff: '2' }), 1),
    ).toThrow('tape line 1: tapediff');
  });

  it('reports physical line numbers and readable field errors', () => {
    expect(() =>
      parseTapeLine(JSON.stringify({ ...exchange, matchKey: 'bad' }), 17),
    ).toThrow('tape line 17: matchKey: expected a SHA-256 hex digest');
    expect(() => parseTapeLine('not JSON', 4)).toThrow(
      'tape line 4: invalid JSON',
    );
    expect(() => parseTapeLine('null', 1)).toThrow('tape line 1: record');
  });

  it('does not echo invalid JSON or secret body property names in errors', () => {
    const secret = 'sk-proj-fakefixturesecret0123456789';
    for (const input of [
      secret,
      JSON.stringify({
        ...exchange,
        request: { ...exchange.request, body: undefined },
      }),
    ]) {
      try {
        parseTapeLine(input, 3);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it.each([
    { id: -1 },
    { seq: 0.5 },
    { provider: 'other' },
    { endpoint: 'relative' },
    { matchKey: 'x'.repeat(64) },
    { costUsd: -0.01 },
    { request: { ...exchange.request, body: undefined } },
    { request: { ...exchange.request, headers: { test: 1 } } },
    { response: { status: 99, headers: {} } },
    { response: { status: 600, headers: {} } },
    { response: { status: 200, headers: {}, sse: [{ t: -1, data: 'x' }] } },
    { response: { status: 200, headers: {}, sse: [{ t: 0, data: 1 }] } },
    { timing: { startedAt: 'yesterday', latencyMs: 0 } },
    { timing: { ...exchange.timing, latencyMs: Infinity } },
    { usage: { inputTokens: 1.5, outputTokens: 1 } },
  ])('rejects malformed exchange fields: %j', (change) => {
    expect(exchangeSchema.safeParse({ ...exchange, ...change }).success).toBe(
      false,
    );
  });

  it('allows generic error, empty, null, and text responses and zero cost', () => {
    for (const response of [
      { status: 429, headers: {}, body: { error: 'rate limited' } },
      { status: 204, headers: {} },
      { status: 200, headers: {}, body: null },
      { status: 500, headers: {}, body: 'upstream unavailable' },
    ]) {
      expect(
        exchangeSchema.safeParse({
          ...exchange,
          provider: 'unknown',
          response,
          costUsd: 0,
        }).success,
      ).toBe(true);
    }
    expect(
      tapeHeaderSchema.safeParse({
        ...header,
        createdAt: '2026-10-08T16:00:00+04:00',
      }).success,
    ).toBe(true);
  });

  it.each(['{"id":', '{"id":"cut', '{"id":1.', '{"id":1e'])(
    'marks EOF syntax errors incomplete: %s',
    (line) => {
      try {
        parseTapeLine(line, 2);
      } catch (error) {
        expect(error).toBeInstanceOf(TapeSyntaxError);
        expect((error as TapeSyntaxError).incomplete).toBe(true);
      }
    },
  );

  it('recognizes every incomplete prefix of an exchange, including escaped strings', () => {
    const line = JSON.stringify({
      ...exchange,
      response: {
        ...exchange.response,
        body: { escaped: '\u0000\n"\\', unicode: 'გამარჯობა', flag: true },
      },
    });
    for (let end = 1; end < line.length; end++) {
      expect(
        () => parseTapeLine(line.slice(0, end), 2),
        `prefix length ${end}`,
      ).toThrow('incomplete record');
    }
  });
});

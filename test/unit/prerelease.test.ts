import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveUpstreams, upstreamUrl } from '../../src/proxy/server.js';
import { TapeWriter, readTape } from '../../src/tape/io.js';
import { redactBody, redactSse } from '../../src/tape/redact.js';
import { findTapes } from '../../src/commands/find-tapes.js';
import { header, exchange } from './tape-fixtures.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  [
    'https://generativelanguage.googleapis.com/v1beta/openai/',
    '/v1/chat/completions',
    'openai',
    '/v1beta/openai/chat/completions',
  ],
  [
    'https://gateway.test/tenant/openai',
    '/v1/chat/completions',
    'openai',
    '/tenant/openai/chat/completions',
  ],
  ['https://api.openai.com', '/v1/responses', 'openai', '/v1/responses'],
  [
    'https://api.openai.com/',
    '/v1/chat/completions',
    'openai',
    '/v1/chat/completions',
  ],
  [
    'https://gateway.test/base/v1/',
    '/v1/responses',
    'openai',
    '/base/v1/responses',
  ],
  ['https://gateway.test/base', '/custom', 'openai', '/base/custom'],
  [
    'https://gateway.test/base?tenant=1',
    '/v1/messages?x=2',
    'anthropic',
    '/base/v1/messages?tenant=1&x=2',
  ],
  [
    'https://gateway.test/base/v1',
    '/v1/messages',
    'anthropic',
    '/base/v1/v1/messages',
  ],
] as const)('joins %s and %s for %s', (base, route, provider, expected) => {
  const result = upstreamUrl(base, route, provider);
  expect(result.pathname + result.search).toBe(expected);
});

it('uses OPENAI_API_BASE after the explicit override and OPENAI_BASE_URL', () => {
  const env = { OPENAI_API_BASE: 'https://legacy.test/openai' };
  expect(resolveUpstreams(env).openai).toBe(env.OPENAI_API_BASE);
  expect(
    resolveUpstreams({ ...env, OPENAI_BASE_URL: 'https://base.test' }).openai,
  ).toBe('https://base.test');
  expect(
    resolveUpstreams({
      ...env,
      OPENAI_BASE_URL: 'https://base.test',
      TAPEDIFF_OPENAI_UPSTREAM: 'https://override.test',
    }).openai,
  ).toBe('https://override.test');
});

it.each(['[0-9a-f]{32}', '\\d{4}', 'sk-[A-Za-z0-9_-]{16,}'])(
  'redacts only content with %s, retaining structural fields',
  async (pattern) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-structure-'));
    const file = path.join(dir, 'test.tape');
    const value = '2026 ' + 'a'.repeat(64) + ' sk-fake0123456789abcdefgh';
    const original = {
      ...exchange,
      model: value,
      endpoint: '/' + value,
      request: {
        ...exchange.request,
        headers: { 'x-request-id': value },
        body: { value },
      },
      response: {
        status: 200,
        headers: { 'x-request-id': value },
        body: { value },
        sse: [{ t: 2026, data: `data: ${value}\n\n` }],
      },
    };
    try {
      const writer = await TapeWriter.open(
        file,
        { ...header, command: [value] },
        [pattern],
      );
      try {
        await writer.appendExchange(original);
      } finally {
        await writer.close();
      }
      const tape = await readTape(file);
      const saved = tape.exchanges[0]!;
      const structure = Object.fromEntries(
        Object.entries(original).filter(
          ([key]) => key !== 'request' && key !== 'response',
        ),
      );
      expect(saved).toMatchObject(structure);
      expect(saved.request.path).toBe(original.request.path);
      expect(saved.request.headers['x-request-id']).toBe(
        redactBody(value, [pattern]),
      );
      expect(saved.response.headers['x-request-id']).toBe(
        redactBody(value, [pattern]),
      );
      expect(saved.request.body).toEqual(redactBody({ value }, [pattern]));
      expect(saved.response.body).toEqual(redactBody({ value }, [pattern]));
      expect(saved.response.sse?.[0]?.t).toBe(2026);
      expect(saved.response.sse?.[0]?.data).toContain('[REDACTED]');
      expect(tape.header.createdAt).toBe(header.createdAt);
      expect(tape.header.command).toEqual([redactBody(value, [pattern])]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('preserves object key order throughout redaction', () => {
  const body = {
    first: 1,
    second: { alpha: 'safe', beta: 2 },
    third: [{ one: 1, two: 2 }],
  };
  expect(JSON.stringify(redactBody(body))).toBe(JSON.stringify(body));
});

it('keeps untouched SSE frames byte-identical, including whitespace and multiple data lines', () => {
  const data =
    ': comment\r\nevent: message\r\ndata: { "first": 1,\r\ndata: "second": {"a":1,"b":2} }\r\n\r\ndata: [DONE]\n\n';
  expect(
    redactSse([{ t: 0, data }])
      .map((frame) => frame.data)
      .join(''),
  ).toBe(data);
});

it('does not interpret cwd brackets as glob syntax', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-cwd-'));
  const cwd = path.join(dir, 'proj[1]');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'a.tape'), '');
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    expect(await findTapes('*.tape')).toEqual([path.join(cwd, 'a.tape')]);
    expect(await findTapes('missing.tape')).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses one shared tape reader and version error classifier', async () => {
  for (const name of ['commands/diff', 'commands/show', 'proxy/replay']) {
    const source = await readFile(
      new URL(`../../src/${name}.ts`, import.meta.url),
      'utf8',
    );
    expect(source).toContain('readTapeOrFail');
    expect(source).not.toContain('/^tape line 1: tape version');
  }
  expect(
    await readFile(new URL('../../src/cli.ts', import.meta.url), 'utf8'),
  ).toContain('isTapeVersionError');
});

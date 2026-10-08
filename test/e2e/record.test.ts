import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../helpers/cli.js';

import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { readTape } from '../../src/tape/io.js';
import { tokens } from '../../src/format.js';
import { stepTotals } from '../../src/totals.js';
import { toSteps } from '../../src/steps.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tapediff-record-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it.each(['openai', 'anthropic'])(
  'records real %s SDK two-turn tool loops, streaming and JSON',
  async (provider) => {
    const fake = await fakeUpstream();
    try {
      for (const stream of [false, true]) {
        const out = path.join(dir, `${provider}-${stream}.tape`);
        const result = await run(
          [
            'record',
            '--out',
            out,
            '--name',
            'sdk loop',
            '--',
            process.execPath,
            `test/e2e/agents/${provider}.mjs`,
            ...(stream ? ['--stream'] : []),
          ],
          {
            TAPEDIFF_OPENAI_UPSTREAM: `${fake.url}/v1`,
            TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
            AGENT_EXIT_CODE: '7',
          },
        );
        expect(result.code, result.stderr).toBe(7);
        expect(result.stderr).toContain('recorded 2 exchanges');
        expect(result.stderr).toContain('tokens · $0.');
        const tape = await readTape(out);
        expect(result.stderr).toContain(
          `${tokens(stepTotals(toSteps(tape.exchanges)).tokens)} tokens`,
        );
        expect(tape.header.name).toBe('sdk loop');
        expect(tape.exchanges.map((e) => e.seq)).toEqual([0, 1]);
        expect(tape.exchanges.every((e) => e.provider === provider)).toBe(true);
        for (const exchange of tape.exchanges) {
          expect(exchange.response.status).toBe(200);
          expect(exchange.usage).toMatchObject({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
          });
          expect(exchange.costUsd).toBeCloseTo(
            provider === 'openai' ? 0.0004375 : 0.00062175,
            10,
          );
          if (stream) expect(exchange.response.sse!.length).toBeGreaterThan(1);
          else expect(exchange.response.body).toBeTypeOf('object');
        }
        expect(JSON.stringify(tape.exchanges[1]?.request.body)).toContain(
          provider === 'openai' ? 'tool_call_id' : 'tool_result',
        );
        const raw = await readFile(out, 'utf8');
        expect(raw).not.toContain('sk-proj-fake');
        expect(raw).not.toContain('sk-ant-fake');
        expect(raw).not.toContain('authorization');
        expect(raw).not.toContain('x-api-key');
        expect(raw).toContain('lookup');
      }
      expect(
        fake.requests.every(
          (req) => req.headers['accept-encoding'] === 'identity',
        ),
      ).toBe(true);
      expect(
        fake.requests.every(
          (req) =>
            req.path ===
            (provider === 'openai' ? '/v1/chat/completions' : '/v1/messages'),
        ),
      ).toBe(true);
      expect(
        fake.requests[0]?.headers[
          provider === 'openai' ? 'authorization' : 'x-api-key'
        ],
      ).toContain('fake0123456789abcdefgh');
    } finally {
      await fake.close();
    }
  },
  30_000,
);

it('records Responses SDK JSON and response.completed usage, using pre-existing base URLs', async () => {
  const fake = await fakeUpstream();
  try {
    for (const stream of [false, true]) {
      const out = path.join(dir, `responses-${stream}.tape`);
      const result = await run(
        [
          'record',
          '--out',
          out,
          '--',
          process.execPath,
          'test/e2e/agents/responses.mjs',
          ...(stream ? ['--stream'] : []),
        ],
        { OPENAI_BASE_URL: `${fake.url}/gateway/v1` },
      );
      expect(result.code, result.stderr).toBe(0);
      const exchange = (await readTape(out)).exchanges[0]!;
      expect(exchange.endpoint).toBe('/v1/responses');
      expect(exchange.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
      });
      expect(exchange.costUsd).toBeCloseTo(0.000345, 10);
    }
    expect(
      fake.requests.every((req) => req.path === '/gateway/v1/responses'),
    ).toBe(true);
  } finally {
    await fake.close();
  }
});

it('refuses overwrite, --force replaces, forwards child arguments/env, and reports spawn failure', async () => {
  const out = path.join(dir, 'existing.tape');
  await writeFile(out, 'do not overwrite');
  const args = [
    'record',
    '--out',
    out,
    '--',
    process.execPath,
    '-e',
    'process.exit(9)',
  ];
  const refused = await run(args);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain('--force');
  expect(await readFile(out, 'utf8')).toBe('do not overwrite');
  const forced = await run([
    'record',
    '--force',
    '--out',
    out,
    '--',
    process.execPath,
    '-e',
    'if (process.env.OPENAI_API_BASE !== process.env.OPENAI_BASE_URL) process.exit(99); process.exit(9)',
  ]);
  expect(forced.code, forced.stderr).toBe(9);
  expect((await readTape(out)).exchanges).toEqual([]);
  const missing = await run([
    'record',
    '--out',
    path.join(dir, 'missing.tape'),
    '--',
    'tapediff-nonexistent-command-1234',
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('could not start child command');
});

it('flushes an aborted exchange when the child exits mid-stream', async () => {
  const fake = await fakeUpstream({ delayMs: 100 });
  try {
    const out = path.join(dir, 'aborted.tape');
    const result = await run(
      [
        'record',
        '--out',
        out,
        '--',
        process.execPath,
        'test/e2e/agents/exit-stream.mjs',
      ],
      { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    );
    expect(result.code, result.stderr).toBe(4);
    const tape = await readTape(out);
    expect(tape.exchanges).toHaveLength(1);
    expect(tape.exchanges[0]?.aborted).toBe(true);
    expect(tape.exchanges[0]?.response.sse?.length).toBeGreaterThan(0);
    expect(fake.aborted).toBe(true);
  } finally {
    await fake.close();
  }
});

it.each([200, 429, 502])(
  'persists generic requests without model/usage, including status %i',
  async (status) => {
    const fake = await fakeUpstream({
      status,
      disconnect: status === 502,
      ...(status === 200 ? { responseText: 'plain' } : {}),
    });
    try {
      const out = path.join(dir, 'generic.tape');
      const result = await run(
        [
          'record',
          '--out',
          out,
          '--',
          process.execPath,
          'test/e2e/agents/generic.mjs',
        ],
        { ANTHROPIC_BASE_URL: fake.url, EXPECT_STATUS: String(status) },
      );
      expect(result.code, result.stderr).toBe(0);
      const exchange = (await readTape(out)).exchanges[0]!;
      expect(exchange.response.status).toBe(status);
      expect(exchange.model).toBeUndefined();
      expect(exchange.usage).toBeUndefined();
      expect(exchange.costUsd).toBeNull();
      expect(exchange.request.body).toEqual({
        tool: { api_key: '[REDACTED]' },
        max_tokens: 100,
      });
      expect(await readFile(out, 'utf8')).not.toContain('abc123');
      expect(fake.requests[0]?.path).toBe('/custom?x=1');
      if (status === 200) expect(exchange.response.body).toBe('plain');
    } finally {
      await fake.close();
    }
  },
);

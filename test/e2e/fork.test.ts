import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { run } from '../helpers/cli.js';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { readTape, TapeWriter } from '../../src/tape/io.js';
import { header, exchange } from '../unit/tape-fixtures.js';
import { money, tokens } from '../../src/format.js';
import { stepTotals } from '../../src/totals.js';
import { toSteps } from '../../src/steps.js';
import { createForkHandler } from '../../src/proxy/fork.js';
import { createProxy } from '../../src/proxy/server.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tapediff-fork-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const command = (provider = 'openai', stream = false) => [
  process.execPath,
  `test/e2e/agents/${provider}.mjs`,
  ...(stream ? ['--stream'] : []),
];

it('serves call #1 and permanently switches at an edited call #2', async () => {
  const fake = await fakeUpstream();
  try {
    const source = path.join(dir, 'source.tape');
    const cmd = command('openai-sequence');
    const env = { TAPEDIFF_OPENAI_UPSTREAM: fake.url };
    const recorded = await run(['record', '--out', source, '--', ...cmd], env);
    expect(recorded.code, recorded.stderr).toBe(0);
    expect(fake.requests).toHaveLength(3);
    const thirdRequest = fake.requests[2]!.body;
    fake.requests.length = 0;
    const result = await run(['fork', source, '--', ...cmd], {
      ...env,
      AGENT_SECOND_PROMPT: 'Edited call 2',
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'fork: diverged at call #2 (POST /v1/chat/completions), going live',
    );
    expect(result.stderr).toContain('fork: 1 call from tape · 2 live');
    expect(result.stderr).not.toContain('never requested');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.body.messages).toEqual([
      { role: 'user', content: 'Edited call 2' },
    ]);
    expect(fake.requests[1]?.body).toEqual(thirdRequest);
    const fork = await readTape(path.join(dir, 'source.fork.tape'));
    expect(fork.exchanges.map((entry) => entry.servedFrom)).toEqual([
      { seq: 0 },
      undefined,
      undefined,
    ]);
  } finally {
    await fake.close();
  }
});

it.each([undefined, 4])(
  'warns about unused calls only when a run stops before going live (at=%s)',
  async (at) => {
    const fake = await fakeUpstream();
    try {
      const source = path.join(dir, 'source.tape');
      const cmd = command('openai-sequence');
      const env = { TAPEDIFF_OPENAI_UPSTREAM: fake.url };
      expect(
        (await run(['record', '--out', source, '--', ...cmd], env)).code,
      ).toBe(0);
      fake.requests.length = 0;
      for (const calls of [1, 2]) {
        const result = await run(
          [
            'fork',
            source,
            '--force',
            ...(at ? ['--at', String(at)] : []),
            '--',
            ...cmd,
          ],
          { ...env, AGENT_CALLS: String(calls) },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          calls === 1
            ? 'fork: 1 call from tape · 0 live'
            : 'fork: 2 calls from tape · 0 live',
        );
        expect(result.stderr).toContain(
          calls === 1
            ? 'warning: 2 recorded calls were never requested'
            : 'warning: 1 recorded call was never requested',
        );
      }
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  },
);

it('pluralizes the summary hint when two changed requests are served', async () => {
  const fake = await fakeUpstream();
  try {
    const source = path.join(dir, 'source.tape');
    const env = { TAPEDIFF_OPENAI_UPSTREAM: fake.url };
    expect(
      (await run(['record', '--out', source, '--', ...command()], env)).code,
    ).toBe(0);
    fake.requests.length = 0;
    const result = await run(
      ['fork', source, '--at', '3', '--', ...command()],
      {
        ...env,
        AGENT_PROMPT: 'Changed prompt',
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      '2 calls were served from the tape even though their requests changed; see docs/fork.md',
    );
    expect(result.stderr).toContain('fork: 2 calls from tape · 0 live');
    expect(result.stderr).not.toContain('never requested');
    expect(fake.requests).toHaveLength(0);
  } finally {
    await fake.close();
  }
});

it.each(['openai', 'anthropic'])(
  'forks an unchanged %s SDK run offline and replays/diffs the output',
  async (provider) => {
    const fake = await fakeUpstream();
    try {
      const source = path.join(dir, 'source.tape');
      const env = {
        TAPEDIFF_OPENAI_UPSTREAM: fake.url,
        TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
      };
      expect(
        (
          await run(
            ['record', '--out', source, '--', ...command(provider)],
            env,
          )
        ).code,
      ).toBe(0);
      fake.requests.length = 0;
      const result = await run(
        ['fork', source, '--diff', '--no-color', '--', ...command(provider)],
        env,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(fake.requests).toHaveLength(0);
      expect(result.stderr).toContain('fork: 2 calls from tape · 0 live');
      const out = path.join(dir, 'source.fork.tape');
      const original = await readTape(source);
      const fork = await readTape(out);
      expect(fork.header.forkedFrom).toEqual({
        tape: source,
        at: null,
        mode: 'divergence',
        sourceCreatedAt: original.header.createdAt,
      });
      expect(fork.header.command).toEqual(command(provider));
      expect(fork.exchanges.map((e) => e.servedFrom)).toEqual([
        { seq: 0 },
        { seq: 1 },
      ]);
      expect(fork.exchanges.map((e) => e.response)).toEqual(
        original.exchanges.map((e) => e.response),
      );
      expect(fork.exchanges.map((e) => e.timing.latencyMs)).toEqual(
        original.exchanges.map((e) => e.timing.latencyMs),
      );
      const saved = stepTotals(toSteps(original.exchanges));
      expect(result.stderr).toContain(
        `saved ${money(saved.costUsd)} (${tokens(saved.tokens)} tokens)`,
      );
      expect(
        (await run(['replay', out, '--', ...command(provider)])).code,
      ).toBe(0);
      const diff = await run(['diff', source, out, '--no-color']);
      expect(diff.code).toBe(0);
      expect(result.stdout).toBe(`It is sunny.\n${diff.stdout}`);
      const show = await run(['show', out]);
      expect(show.stdout).toContain('forked from');
      expect(show.stdout).toContain('#1 (from tape)');
      const json = JSON.parse((await run(['show', out, '--json'])).stdout) as {
        steps: { servedFrom?: { seq: number } }[];
      };
      expect(json.steps.filter((step) => step.servedFrom)).toHaveLength(2);
      expect((await run(['diff', source, out, '--json'])).stdout).not.toContain(
        'servedFrom',
      );
    } finally {
      await fake.close();
    }
  },
  30_000,
);

it('goes live at divergence, or serves a changed prefix positionally and replays the edited requests', async () => {
  const fake = await fakeUpstream();
  try {
    const source = path.join(dir, 'source.tape');
    const env = { OPENAI_BASE_URL: `${fake.url}/gateway/v1` };
    expect(
      (await run(['record', '--out', source, '--', ...command()], env)).code,
    ).toBe(0);
    for (const at of [undefined, 2]) {
      fake.requests.length = 0;
      const out = path.join(dir, `fork-${at}.tape`);
      const changed = {
        ...env,
        AGENT_PROMPT: 'A changed prompt',
        AGENT_EXIT_CODE: '7',
        FORCE_COLOR: '1',
        NO_COLOR: '',
      };
      const result = await run(
        [
          'fork',
          source,
          '--out',
          out,
          ...(at ? ['--at', String(at)] : []),
          '--diff',
          '--',
          ...command(),
        ],
        changed,
      );
      expect(result.code, result.stderr).toBe(7);
      expect(fake.requests).toHaveLength(at ? 1 : 2);
      expect(
        fake.requests.every(
          (request) => request.path === '/gateway/v1/chat/completions',
        ),
      ).toBe(true);
      expect(fake.requests[0]?.headers.authorization).toContain(
        'fake0123456789abcdefgh',
      );
      const fork = await readTape(out);
      expect(fork.exchanges.filter((e) => e.servedFrom)).toHaveLength(
        at ? 1 : 0,
      );
      expect(result.stderr).toContain(
        at
          ? 'call #1 served from tape although its request changed'
          : 'diverged at call #1',
      );
      if (at) {
        expect(result.stderr).toContain(
          '1 call was served from the tape even though its request changed; see docs/fork.md',
        );
        expect(result.stderr).not.toContain('never requested');
        expect((await run(['show', out])).stdout).toContain('at #2');
      } else {
        expect(result.stderr).toContain('recorded request');
        expect(result.stderr).toContain('incoming request');
      }
      const replay = await run(['replay', out, '--', ...command()], {
        AGENT_PROMPT: changed.AGENT_PROMPT,
      });
      expect(replay.code, replay.stderr).toBe(0);
      const diff = await run(['diff', source, out, '--no-color']);
      expect(diff.code).toBe(1);
      expect(result.stdout).toBe(`It is sunny.\n${diff.stdout}`);
      expect(result.stdout).not.toContain('\u001b[');
      expect(await readFile(out, 'utf8')).not.toContain('sk-proj-fake');
    }
  } finally {
    await fake.close();
  }
}, 30_000);

it.each(['openai', 'anthropic'])(
  'serves recorded %s SSE with the SDK and preserves recorded frames and timing',
  async (provider) => {
    const fake = await fakeUpstream({ delayMs: 35 });
    try {
      const source = path.join(dir, 'source.tape');
      const env = {
        TAPEDIFF_OPENAI_UPSTREAM: fake.url,
        TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
      };
      expect(
        (
          await run(
            ['record', '--out', source, '--', ...command(provider, true)],
            env,
          )
        ).code,
      ).toBe(0);
      const original = await readTape(source);
      fake.requests.length = 0;
      const start = performance.now();
      const result = await run(
        [
          'fork',
          source,
          '--pace',
          'recorded',
          '--',
          ...command(provider, true),
        ],
        env,
      );
      const elapsed = performance.now() - start;
      expect(result.code, result.stderr).toBe(0);
      expect(fake.requests).toHaveLength(0);
      const recordedMs = original.exchanges.reduce(
        (sum, e) => sum + e.response.sse!.at(-1)!.t,
        0,
      );
      expect(elapsed).toBeGreaterThan(recordedMs - 50);
      expect(elapsed).toBeLessThan(recordedMs + 8_000);
      const handler = createForkHandler(original.exchanges, {
        appendExchange: () => Promise.resolve(),
      });
      const proxy = await createProxy({
        mode: 'fork',
        handler: handler.handler,
        env,
      });
      try {
        for (const entry of original.exchanges) {
          const response = await fetch(
            `http://127.0.0.1:${proxy.port}${entry.request.path}`,
            {
              method: entry.request.method,
              body: JSON.stringify(entry.request.body),
            },
          );
          expect(await response.text()).toBe(
            entry.response.sse!.map((chunk) => chunk.data).join(''),
          );
        }
        expect(fake.requests).toHaveLength(0);
      } finally {
        await proxy.close();
      }
      const fork = await readTape(path.join(dir, 'source.fork.tape'));
      expect(fork.exchanges.map((e) => e.response.sse)).toEqual(
        original.exchanges.map((e) => e.response.sse),
      );
      expect(
        (
          await run([
            'replay',
            path.join(dir, 'source.fork.tape'),
            '--',
            ...command(provider, true),
          ])
        ).code,
      ).toBe(0);
      fake.requests.length = 0;
      const partial = await run(
        [
          'fork',
          source,
          '--at',
          '2',
          '--force',
          '--',
          ...command(provider, true),
        ],
        env,
      );
      expect(partial.code, partial.stderr).toBe(0);
      expect(fake.requests).toHaveLength(1);
      expect(
        (await readTape(path.join(dir, 'source.fork.tape'))).exchanges[0]
          ?.response.sse,
      ).toEqual(original.exchanges[0]?.response.sse);
    } finally {
      await fake.close();
    }
  },
  30_000,
);

it('refuses existing output, overwrites with --force, and substitutes the source path without injecting keys', async () => {
  const source = path.join(dir, 'source.tape');
  await (await TapeWriter.open(source, header)).close();
  const out = path.join(dir, 'existing.tape');
  await writeFile(out, 'keep');
  const child = [
    process.execPath,
    '-e',
    'if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.argv[1] !== process.env.TAPEDIFF_TAPE) process.exit(99); process.exit(8)',
    '{tape}',
  ];
  const args = ['fork', source, '--out', out];
  const env = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const refused = await run([...args, '--', ...child], env);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(
    'output tape exists; use --force to overwrite',
  );
  expect(await readFile(out, 'utf8')).toBe('keep');
  const result = await run(
    [...args, '--force', '--at', '1', '--diff', '--', ...child],
    env,
  );
  expect(result.code, result.stderr).toBe(8);
  expect(result.stderr).toContain(
    'neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set',
  );
  expect((await readTape(out)).header.command.at(-1)).toBe(
    path.resolve(source),
  );
  expect((await readTape(out)).header.forkedFrom?.at).toBe(1);
  expect((await readTape(out)).exchanges).toEqual([]);
});

it.each(['0', '-1', '1.5', '2x', 'NaN', 'Infinity', '1e2', '9007199254740992'])(
  'rejects invalid --at %s as a usage error',
  async (at) => {
    const result = await run([
      'fork',
      'missing.tape',
      '--at',
      at,
      '--',
      ...command(),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('must be an integer >= 1');
  },
);

it('flushes a live aborted exchange after a served prefix when the child exits', async () => {
  const sourceFake = await fakeUpstream();
  const source = path.join(dir, 'source.tape');
  try {
    expect(
      (
        await run(['record', '--out', source, '--', ...command()], {
          TAPEDIFF_OPENAI_UPSTREAM: sourceFake.url,
        })
      ).code,
    ).toBe(0);
  } finally {
    await sourceFake.close();
  }
  let release!: () => void;
  const fake = await fakeUpstream({
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  try {
    const result = await run(
      [
        'fork',
        source,
        '--at',
        '2',
        '--',
        process.execPath,
        'test/e2e/agents/fork-abort.mjs',
      ],
      { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    );
    expect(result.code, result.stderr).toBe(4);
    const tape = await readTape(path.join(dir, 'source.fork.tape'));
    expect(tape.exchanges).toHaveLength(2);
    expect(tape.exchanges[0]?.servedFrom).toEqual({ seq: 0 });
    expect(tape.exchanges[1]?.aborted).toBe(true);
    expect(tape.exchanges[1]?.response.sse?.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.aborted).toBe(true);
  } finally {
    release();
    await fake.close();
  }
});

it('redacts source provenance in the header and summary', async () => {
  const source = path.join(dir, 'sk-abcdefghijklmnopqrst.tape');
  const writer = await TapeWriter.open(source, header);
  await writer.close();
  const result = await run([
    'fork',
    source,
    '--',
    process.execPath,
    '-e',
    'process.exit(0)',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const output = await readFile(
    path.join(dir, 'sk-abcdefghijklmnopqrst.fork.tape'),
    'utf8',
  );
  expect(output).not.toContain('sk-abcdefghijklmnopqrst');
  expect(output).toContain('[REDACTED]');
  expect(result.stderr).not.toContain('sk-abcdefghijklmnopqrst');
});

it('reports unknown saved cost and excludes unknown-provider exchanges from the summary', async () => {
  const source = path.join(dir, 'source.tape');
  const writer = await TapeWriter.open(source, header);
  await writer.appendExchange({ ...exchange, costUsd: null });
  await writer.appendExchange({
    ...exchange,
    id: 1,
    seq: 1,
    provider: 'unknown',
    costUsd: 20,
  });
  await writer.close();
  const child = `const r = ${JSON.stringify(exchange.request)}; for (let i = 0; i < 2; i++) { await (await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', { method: r.method, body: JSON.stringify(r.body) })).text(); }`;
  const fake = await fakeUpstream();
  try {
    const result = await run(
      [
        'fork',
        source,
        '--',
        process.execPath,
        '--input-type=module',
        '-e',
        child,
      ],
      { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'fork: 1 call from tape · 1 live · saved cost unknown',
    );
    expect(result.stderr).not.toContain('never requested');
    expect(fake.requests).toHaveLength(1);
  } finally {
    await fake.close();
  }
});

it.each([1, 2])(
  'pluralizes the saved token count for %i',
  async (inputTokens) => {
    const source = path.join(dir, 'source.tape');
    const writer = await TapeWriter.open(source, header);
    await writer.appendExchange({
      ...exchange,
      usage: { inputTokens, outputTokens: 0 },
    });
    await writer.close();
    const child = `const r = ${JSON.stringify(exchange.request)}; await (await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', { method: r.method, body: JSON.stringify(r.body) })).text();`;
    const result = await run(
      [
        'fork',
        source,
        '--',
        process.execPath,
        '--input-type=module',
        '-e',
        child,
      ],
      {
        TAPEDIFF_OPENAI_UPSTREAM: 'http://127.0.0.1:1',
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      inputTokens === 1 ? '(1 token)' : '(2 tokens)',
    );
  },
);

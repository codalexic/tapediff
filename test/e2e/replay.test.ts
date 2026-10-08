import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { run } from '../helpers/cli.js';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { readTape } from '../../src/tape/io.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tapediff-replay-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function record(provider = 'openai', stream = false, delayMs = 0) {
  const fake = await fakeUpstream({ delayMs });
  const tape = path.join(dir, `${provider}-${stream}.tape`);
  const command = [
    process.execPath,
    `test/e2e/agents/${provider}.mjs`,
    ...(stream ? ['--stream'] : []),
  ];
  try {
    const result = await run(['record', '--out', tape, '--', ...command], {
      TAPEDIFF_OPENAI_UPSTREAM: fake.url,
      TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
    });
    expect(result.code, result.stderr).toBe(0);
    return { tape, command, result, upstream: fake.url };
  } finally {
    await fake.close();
  }
}

it('record preserves absent and empty keys without replay placeholders', async () => {
  for (const key of [undefined, '']) {
    const script =
      'if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) process.exit(99)';
    const result = await run(
      [
        'record',
        '--out',
        path.join(dir, `keys-${key === undefined ? 'absent' : 'empty'}.tape`),
        '--',
        process.execPath,
        '-e',
        script,
      ],
      {
        OPENAI_API_KEY: key,
        ANTHROPIC_API_KEY: key,
      },
    );
    expect(result.code, result.stderr).toBe(0);
  }
});

it.each(['openai', 'anthropic', 'responses'])(
  'replays %s SDK JSON and SSE with upstream shut down and identical stdout',
  async (provider) => {
    for (const stream of [false, true]) {
      const { tape, command, result, upstream } = await record(
        provider,
        stream,
      );
      expect(result.stdout.length).toBeGreaterThan(0);
      const replayed = await run(['replay', tape, '--', ...command], {
        TAPEDIFF_OPENAI_UPSTREAM: upstream,
        TAPEDIFF_ANTHROPIC_UPSTREAM: upstream,
      });
      expect(replayed.code, replayed.stderr).toBe(0);
      expect(replayed.stdout).toBe(result.stdout);
      expect(replayed.stderr).toContain('0 misses');
      expect(replayed.stderr).not.toContain('never requested');
    }
  },
  30_000,
);

it.each(['openai', 'anthropic'])(
  'replays %s and tests tapes with absent or empty keys, preserving provided keys',
  async (provider) => {
    const { tape, command, result } = await record(provider);
    for (const key of [undefined, '', 'provided-test-key']) {
      const env = { OPENAI_API_KEY: key, ANTHROPIC_API_KEY: key };
      const check = `if (process.env.OPENAI_API_KEY !== ${JSON.stringify(key || 'tapediff-replay')} || process.env.ANTHROPIC_API_KEY !== ${JSON.stringify(key || 'tapediff-replay')}) process.exit(99); await import('./test/e2e/agents/${provider}.mjs');`;
      const replayed = await run(
        [
          'replay',
          tape,
          '--',
          process.execPath,
          '--input-type=module',
          '-e',
          check,
        ],
        env,
      );
      expect(replayed.code, replayed.stderr).toBe(0);
      expect(replayed.stdout).toBe(result.stdout);
    }
    const tested = await run(['test', tape, '--', ...command], {
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    });
    expect(tested.code, tested.stderr).toBe(0);
  },
  30_000,
);

it.each(['openai', 'anthropic'])(
  'strict %s miss exits 3, prints a request diff, and stops default SDK retries after one request',
  async (provider) => {
    const { tape } = await record(provider);
    const command = [
      process.execPath,
      'test/e2e/agents/replay-miss.mjs',
      provider,
    ];
    const result = await run(['replay', tape, '--strict', '--', ...command]);
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toContain('APIError status=500 requests=1');
    expect(result.stderr).toContain('--- recorded request');
    expect(result.stderr).toContain('+++ incoming request');
    expect(result.stderr).toContain('-        "content": "Weather in Paris?"');
    expect(result.stderr).toContain('+        "content": "Weather in Berlin?"');
    expect(result.stderr).toContain('1 misses');
    expect(result.stderr).toContain('2 recorded calls were never requested');
    const failed = await run(['replay', tape, '--', ...command], {
      AGENT_EXIT_CODE: '7',
    });
    expect(failed.code).toBe(3);
  },
  30_000,
);

it('loose fallback consumes calls once and warns once per mismatching request', async () => {
  const { tape, command, result } = await record();
  const replayed = await run(['replay', tape, '--loose', '--', ...command], {
    AGENT_PROMPT: 'Weather in Berlin?',
  });
  expect(replayed.code, replayed.stderr).toBe(0);
  expect(replayed.stdout).toBe(result.stdout);
  expect(replayed.stderr.match(/warning: replay miss/g)).toHaveLength(2);
  expect(replayed.stderr).toContain('2 fallbacks');
  expect(replayed.stderr).not.toContain('never requested');
});

it('recorded pace honors SSE offsets; instant replay skips those waits', async () => {
  const { tape, command } = await record('openai', true, 60);
  const data = await readTape(tape);
  const duration = data.exchanges.reduce(
    (total, e) => total + Math.max(...e.response.sse!.map((c) => c.t)),
    0,
  );
  expect(duration).toBeGreaterThan(400);
  const start = performance.now();
  const paced = await run([
    'replay',
    tape,
    '--pace',
    'recorded',
    '--',
    ...command,
  ]);
  const elapsed = performance.now() - start;
  expect(paced.code, paced.stderr).toBe(0);
  expect(elapsed).toBeGreaterThanOrEqual(duration);
  const instantStart = performance.now();
  const instant = await run(['replay', tape, '--', ...command]);
  expect(instant.code, instant.stderr).toBe(0);
  expect(performance.now() - instantStart).toBeLessThan(elapsed);
}, 30_000);

it('warns about unused calls without failing replay, and propagates child failures', async () => {
  const { tape, command } = await record();
  const unused = await run(['replay', tape, '--', process.execPath, '-e', '']);
  expect(unused.code, unused.stderr).toBe(0);
  expect(unused.stderr).toContain('2 recorded calls were never requested');
  const failed = await run(['replay', tape, '--', ...command], {
    AGENT_EXIT_CODE: '9',
  });
  expect(failed.code).toBe(9);
  const missing = await run([
    'replay',
    tape,
    '--',
    'tapediff-nonexistent-command-1234',
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('could not start child command');
});

it('tests a recursive directory and glob, with a passing and an unused drifting tape; expands tape arguments/env', async () => {
  const { tape } = await record();
  const data = await readTape(tape);
  const suite = path.join(dir, 'suite');
  await mkdir(path.join(suite, 'nested'), { recursive: true });
  const save = (file: string, extra: boolean) =>
    writeFile(
      file,
      [
        data.header,
        ...data.exchanges,
        ...(extra ? [{ ...data.exchanges[0]!, id: 2, seq: 2 }] : []),
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
  await save(path.join(suite, 'passing.tape'), false);
  await save(path.join(suite, 'nested', 'drifting.tape'), true);
  // This child uses the substituted argument to check the per-tape environment.
  const script =
    'if(process.argv[1] !== process.env.TAPEDIFF_TAPE) process.exit(99); import("./test/e2e/agents/openai.mjs")';
  for (const input of [suite, path.join(suite, '**', '*.tape')]) {
    const result = await run([
      'test',
      input,
      '--',
      process.execPath,
      '-e',
      script,
      '{tape}',
    ]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/PASS .*passing\.tape.*0 unused, child 0/);
    expect(result.stderr).toMatch(/FAIL .*drifting\.tape.*1 unused, child 0/);
  }
  const passing = await run([
    'test',
    path.join(suite, 'passing.tape'),
    '--',
    process.execPath,
    '-e',
    script,
    '{tape}',
  ]);
  expect(passing.code, passing.stderr).toBe(0);
  const failure = await run([
    'test',
    suite,
    '--',
    process.execPath,
    '-e',
    'process.exit(8)',
  ]);
  expect(failure.code).toBe(1);
  expect(failure.stderr).toContain('child 8');
  const miss = await run([
    'test',
    path.join(suite, 'passing.tape'),
    '--',
    process.execPath,
    'test/e2e/agents/replay-miss.mjs',
    'openai',
  ]);
  expect(miss.code, miss.stderr).toBe(1);
  expect(miss.stderr).toMatch(
    /FAIL .*passing\.tape.*1 misses, 2 unused, child 0/,
  );
}, 30_000);

it('reports no matching tapes, invalid input and tape-version errors clearly', async () => {
  const missing = await run([
    'test',
    path.join(dir, '*.tape'),
    '--',
    process.execPath,
    '-e',
    '',
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('no .tape files found');
  const unreadable = await run([
    'replay',
    path.join(dir, 'missing.tape'),
    '--',
    process.execPath,
    '-e',
    '',
  ]);
  expect(unreadable.code).toBe(2);
  expect(unreadable.stderr).toContain('cannot read tape');
  const tape = path.join(dir, 'future.tape');
  await writeFile(tape, '{"tapediff":99}\n');
  const future = await run(['replay', tape, '--', process.execPath, '-e', '']);
  expect(future.code).toBe(2);
  expect(future.stderr).toContain('tape version 99 is newer');
});

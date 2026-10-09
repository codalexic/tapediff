import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  tool,
  wrapTool,
  TapediffToolMissError,
} from '../../src/tools/index.js';
import { createProxy } from '../../src/proxy/server.js';
import { createRecordHandler } from '../../src/proxy/record.js';
import { createReplayHandler } from '../../src/proxy/replay.js';
import { createForkHandler } from '../../src/proxy/fork.js';
import { toolMatchKey } from '../../src/proxy/tools.js';
import { readTape, TapeWriter } from '../../src/tape/io.js';
import { toolRecordSchema, type ToolRecord } from '../../src/tape/schema.js';
import { matchKey } from '../../src/tape/normalize.js';
import { renderSteps } from '../../src/commands/show.js';
import { toSteps } from '../../src/steps.js';
import { detectProvider } from '../../src/providers/detect.js';
import { header, exchange } from '../unit/tape-fixtures.js';
import {
  root,
  cli,
  runExample,
  exampleEnv,
} from '../helpers/example-process.js';

let dir: string;
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tapediff-tools-'));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
async function record() {
  const tape = path.join(dir, 'run.tape');
  const writer = await TapeWriter.open(tape, header);
  cleanup.push(() => writer.close());
  const proxy = await createProxy({
    mode: 'record',
    handler: createRecordHandler(writer),
  });
  cleanup.push(() => proxy.close());
  vi.stubEnv('TAPEDIFF_PROXY_URL', `http://127.0.0.1:${proxy.port}`);
  return { tape, writer, proxy };
}
const post = (route: string, value: unknown) =>
  fetch(`${process.env.TAPEDIFF_PROXY_URL}/tapediff/v1/${route}`, {
    method: 'POST',
    body: JSON.stringify(value),
  });
const start = async (name = 'weather', args: unknown = { city: 'Paris' }) => {
  const response = await post('tools/start', { name, args });
  return (await response.json()) as {
    action: string;
    id: string;
    result?: unknown;
  };
};
function source(
  seq = 1,
  args = { city: 'Paris' },
  result: unknown = { sunny: true },
): ToolRecord {
  return toolRecordSchema.parse({
    kind: 'tool',
    id: seq,
    seq,
    name: 'weather',
    args,
    matchKey: toolMatchKey('weather', args),
    result,
    timing: { startedAt: header.createdAt, latencyMs: 3 },
  });
}

it('preserves direct values, error identity, and wrapper types without a proxy', async () => {
  vi.stubEnv('TAPEDIFF_PROXY_URL', '');
  const result = { notJson: 1n };
  expect(await tool('x', result, (args) => args)).toBe(result);
  expect(await wrapTool('x', (args: number) => args + 1)(2)).toBe(3);
  const error = new RangeError('original');
  await expect(
    tool('x', {}, () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it('records concurrent starts in arrival order, rejects duplicate finishes, and warns once for unfinished tools', async () => {
  const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const { tape, proxy, writer } = await record();
  const first = await start();
  const second = await start('weather', { city: 'Tokyo' });
  expect(first.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(second.id).not.toBe(first.id);
  expect(
    (await post('tools/finish', { id: second.id, result: 2 })).status,
  ).toBe(204);
  expect((await post('tools/finish', { id: first.id, result: 1 })).status).toBe(
    204,
  );
  expect((await post('tools/finish', { id: first.id, result: 1 })).status).toBe(
    400,
  );
  await start('unfinished');
  await start('unfinished');
  await proxy.close();
  await proxy.close();
  await writer.close();
  const data = await readTape(tape);
  expect(data.exchanges).toEqual([]);
  expect(data.header.tapediff).toBe(2);
  expect(data.tools.map((record) => record.id)).toEqual([0, 1]);
  expect(await readFile(tape, 'utf8')).not.toContain(first.id);
  expect(await readFile(tape, 'utf8')).not.toContain(second.id);
  expect(data.tools.map((record) => [record.seq, record.result])).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(data.tools.every((record) => record.timing.latencyMs >= 0)).toBe(true);
  expect(
    warn.mock.calls
      .flat()
      .filter((line) => String(line).includes('unfinished tool')),
  ).toHaveLength(1);
});

it.each([
  ['tools/start', {}],
  ['tools/start', { name: 'x' }],
  ['tools/start', { name: '', args: {} }],
  ['tools/finish', {}],
  ['tools/finish', { id: 'bad', result: 1 }],
  [
    'tools/finish',
    { id: 'bad', result: 1, error: { name: 'Error', message: 'bad' } },
  ],
  ['tools/finish', { id: 'bad', error: { message: 'secret' } }],
  ['other', { secret: 'private' }],
])(
  'rejects malformed protocol input at %s without echoing bodies',
  async (route, value) => {
    const { tape } = await record();
    const response = await post(route, value);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/secret|private/);
    expect((await readTape(tape)).tools).toEqual([]);
  },
);

it('rejects malformed JSON and methods without recording HTTP exchanges', async () => {
  expect(detectProvider('/tapediff/v1/tools/start')).toBe('unknown');
  const { tape } = await record();
  for (const init of [
    { method: 'POST', body: '{private' },
    { method: 'GET' },
  ]) {
    const response = await fetch(
      `${process.env.TAPEDIFF_PROXY_URL}/tapediff/v1/tools/start`,
      init,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private');
  }
  expect((await readTape(tape)).exchanges).toEqual([]);
});

it('surfaces HTTP failures without running the tool or echoing response bodies', async () => {
  await record();
  const fn = vi.fn(() => 1);
  await expect(tool('', {}, fn)).rejects.toThrow('HTTP 400');
  expect(fn).not.toHaveBeenCalled();
});

it('records errors without stacks, undefined as null, and redacts args, results and messages', async () => {
  const { tape } = await record();
  const secret = 'sk-123456789012345678901234';
  const args = { city: secret };
  expect(await tool('weather', args, () => ({ value: secret }))).toEqual({
    value: secret,
  });
  const error = new TypeError(secret);
  await expect(
    tool('failure', {}, () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(await tool('empty', {}, () => undefined)).toBeUndefined();
  const data = await readTape(tape);
  expect(data.tools[0]?.matchKey).toBe(toolMatchKey('weather', args));
  expect(data.tools[2]?.result).toBeNull();
  const raw = await readFile(tape, 'utf8');
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain('stack');
  expect(data.tools[1]?.error).toEqual({
    name: 'TypeError',
    message: '[REDACTED]',
  });
});

it.each(['function', 'bigint', 'cycle', 'symbol', 'infinity'])(
  'rejects %s results before writing any tool record',
  async (kind) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { tape } = await record();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const values: Record<string, unknown> = {
      function: { nested: () => 1 },
      bigint: 1n,
      cycle,
      symbol: Symbol(),
      infinity: Infinity,
    };
    await expect(tool('bad', {}, () => values[kind])).rejects.toThrow(
      TypeError,
    );
    expect((await readTape(tape)).tools).toEqual([]);
  },
);

it('rejects invalid args before sending start and preserves nested undefined as null', async () => {
  const { tape } = await record();
  const fn = vi.fn(() => 1);
  await expect(tool('bad', { fn: () => 1 }, fn)).rejects.toThrow(
    'JSON arguments',
  );
  expect(fn).not.toHaveBeenCalled();
  const result = { missing: undefined, array: [undefined] };
  expect(await tool('nested', null, () => result)).toBe(result);
  expect((await readTape(tape)).tools.map((record) => record.result)).toEqual([
    { missing: null, array: [null] },
  ]);
});

it.each([
  { result: undefined },
  { error: { name: 'Error', message: 'bad' } },
  { kind: 'other' },
  { args: undefined },
  { seq: -1 },
  { id: 'opaque-token' },
  { id: -1 },
  { id: 0.5 },
  { matchKey: 'invalid' },
])('rejects invalid tool tape records: %j', (change) => {
  expect(toolRecordSchema.safeParse({ ...source(), ...change }).success).toBe(
    false,
  );
});

it('snapshots tool writes, rejects invalid records safely, and rejects writes after close', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { writer, tape } = await record();
  await expect(
    writer.appendTool({
      ...source(),
      args: undefined,
    } as unknown as ToolRecord),
  ).rejects.toThrow('invalid tape tool');
  const value = source();
  const pending = writer.appendTool(value);
  value.result = 'changed';
  await pending;
  await writer.close();
  expect((await readTape(tape)).tools[0]?.result).toEqual({ sunny: true });
  await expect(writer.appendTool(source())).rejects.toThrow('writer is closed');
});

it('warns and writes nothing when a child exits after start', async () => {
  const agent = path.join(dir, 'unfinished.mjs');
  await writeFile(
    agent,
    `await fetch(process.env.TAPEDIFF_PROXY_URL + '/tapediff/v1/tools/start', { method: 'POST', body: JSON.stringify({ name: 'unfinished', args: {} }) });`,
  );
  const tape = path.join(dir, 'unfinished.tape');
  const result = await runExample(
    [cli, 'record', '--out', tape, '--', process.execPath, agent],
    root,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr.match(/unfinished tool/g)).toHaveLength(1);
  expect((await readTape(tape)).tools).toEqual([]);
});

it('starts positional forks live at one, even before any LLM request', async () => {
  const written: ToolRecord[] = [];
  const fork = createForkHandler(
    [],
    {
      appendExchange: () => Promise.resolve(),
      appendTool: (record) => {
        written.push(record);
        return Promise.resolve();
      },
    },
    { at: 1, tools: [source()] },
  );
  const proxy = await createProxy({ mode: 'fork', handler: fork.handler });
  cleanup.push(() => proxy.close());
  vi.stubEnv('TAPEDIFF_PROXY_URL', `http://127.0.0.1:${proxy.port}`);
  expect(await tool('weather', { city: 'Paris' }, () => 'live')).toBe('live');
  expect(written[0]?.servedFrom).toBeUndefined();
  expect(fork.stats).toMatchObject({ live: true, tools: 0, liveTools: 1 });
});

it('replays FIFO JSON copies and errors; tools remain strict in loose mode with redacted nearest diffs', async () => {
  const warnings: string[] = [];
  const failure = {
    ...source(4),
    name: 'failure',
    matchKey: toolMatchKey('failure', {}),
    args: {},
    result: undefined,
    error: { name: 'RangeError', message: 'bad' },
  };
  const replay = createReplayHandler(
    [],
    {
      loose: true,
      tools: [source(1), source(2), source(3, { city: 'Tokyo' }), failure],
    },
    (message) => warnings.push(message),
  );
  const proxy = await createProxy({ mode: 'replay', handler: replay.handler });
  cleanup.push(() => proxy.close());
  vi.stubEnv('TAPEDIFF_PROXY_URL', `http://127.0.0.1:${proxy.port}`);
  const fn = vi.fn(() => ({ sunny: false }));
  const first = await tool('weather', { city: 'Paris' }, fn);
  first.sunny = false;
  expect(await tool('weather', { city: 'Paris' }, fn)).toEqual({ sunny: true });
  await expect(tool('failure', {}, fn)).rejects.toMatchObject({
    name: 'RangeError',
    message: 'bad',
    tapediffReplayed: true,
  });
  await expect(
    tool('weather', { city: 'sk-12345678901234567890' }, fn),
  ).rejects.toBeInstanceOf(TapediffToolMissError);
  expect(fn).not.toHaveBeenCalled();
  expect(replay.stats).toMatchObject({
    tools: 3,
    misses: 1,
    unconsumed: 1,
    unusedTools: 1,
    consumed: 0,
  });
  expect(warnings.join('')).toContain('--- recorded args');
  expect(warnings.join('')).toContain('Tokyo');
  expect(warnings.join('')).not.toContain('sk-123');
});

it.each([undefined, 2])(
  'shares the fork live boundary with tools (at=%s)',
  async (at) => {
    const written: ToolRecord[] = [];
    const warnings: string[] = [];
    const body = { model: 'example' };
    const call = {
      ...exchange,
      seq: 0,
      matchKey: matchKey('POST', '/v1/chat/completions', body),
      request: {
        ...exchange.request,
        method: 'POST',
        path: '/v1/chat/completions',
        body,
      },
    };
    const fork = createForkHandler(
      [call, { ...call, seq: 4 }],
      {
        appendExchange: () => Promise.resolve(),
        appendTool: (record) => {
          written.push(record);
          return Promise.resolve();
        },
      },
      { at, tools: [source(10), source(11), source(12)] },
      undefined,
      (message) => warnings.push(message),
    );
    const proxy = await createProxy({
      mode: 'fork',
      handler: fork.handler,
      env: { TAPEDIFF_OPENAI_UPSTREAM: 'http://127.0.0.1:1' },
    });
    cleanup.push(() => proxy.close());
    vi.stubEnv('TAPEDIFF_PROXY_URL', `http://127.0.0.1:${proxy.port}`);
    const llm = () =>
      fetch(`${process.env.TAPEDIFF_PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    await (await llm()).text();
    expect(await tool('weather', { city: 'Paris' }, () => 'live')).toEqual({
      sunny: true,
    });
    expect(written[0]?.servedFrom).toEqual({ seq: 10 });
    expect(written[0]?.id).toBe(1);
    expect(written.every((record) => record.id === record.seq)).toBe(true);
    expect(await tool('weather', { city: 'Berlin' }, () => 'live')).toBe(
      'live',
    );
    expect(fork.stats.live).toBe(at === undefined);
    if (at === undefined)
      expect(warnings.join('')).toContain(
        'fork: tool weather diverged, going live',
      );
    else
      expect(await tool('weather', { city: 'Paris' }, () => 'live')).toEqual({
        sunny: true,
      });
    await (await llm()).text();
    expect(await tool('weather', { city: 'Paris' }, () => 'live')).toBe('live');
    expect(written.at(-1)?.servedFrom).toBeUndefined();
    expect(fork.stats.liveTools).toBe(2);
    expect(written.every((record) => record.id === record.seq)).toBe(true);
  },
);

it('interleaves tools in show, including red errors and provenance, without adding diff steps', () => {
  const calls = [
    { ...exchange, seq: 0 },
    { ...exchange, seq: 3 },
  ];
  const steps = toSteps(calls);
  const text = renderSteps(steps, 200, true, [
    source(1),
    {
      ...source(2),
      result: undefined,
      error: { name: 'Error', message: 'bad' },
      servedFrom: { seq: 5 },
    },
  ]);
  expect(text.indexOf('#1')).toBeLessThan(text.indexOf('⚙'));
  expect(text.indexOf('⚙')).toBeLessThan(text.indexOf('#2'));
  expect(text).toContain('(from tape)');
  expect(text).toContain('Error: "bad"');
  expect(text).toContain('\x1b[31m');
  expect(toSteps(calls)).toEqual(steps);
});

it('reads every existing v1 fixture with zero tools', async () => {
  const files = await readdir(path.join(root, 'test/fixtures'), {
    recursive: true,
  });
  let count = 0;
  for (const file of files.filter((file) => file.endsWith('.tape'))) {
    const tape = path.join(root, 'test/fixtures', file);
    if (
      (
        JSON.parse((await readFile(tape, 'utf8')).split('\n')[0]!) as {
          tapediff: number;
        }
      ).tapediff !== 1
    )
      continue;
    expect((await readTape(tape)).tools).toEqual([]);
    count++;
  }
  expect(count).toBeGreaterThan(10);
});

it('records nondeterministic output then replays twice without executing side effects; direct use still runs', async () => {
  const counter = path.join(dir, 'counter');
  await writeFile(counter, '0');
  const agent = path.join(dir, 'agent.mjs');
  await writeFile(
    agent,
    `import { tool } from ${JSON.stringify(pathToFileURL(path.join(root, 'dist/tools/index.js')).href)};
import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(counter)};
console.log(JSON.stringify(await tool('clock', {}, () => { const n = Number(readFileSync(file, 'utf8')) + 1; writeFileSync(file, String(n)); return { time: Date.now(), n }; })));`,
  );
  const tape = path.join(dir, 'clock.tape');
  const recorded = await runExample(
    [cli, 'record', '--out', tape, '--', process.execPath, agent],
    root,
  );
  expect(recorded.code, recorded.stderr).toBe(0);
  for (let i = 0; i < 2; i++) {
    const replay = await runExample(
      [cli, 'replay', tape, '--', process.execPath, agent],
      root,
    );
    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.stdout).toBe(recorded.stdout);
    expect(replay.stderr).toContain('0 exchanges · 1 tools · 0 misses');
  }
  expect(await readFile(counter, 'utf8')).toBe('1');
  const forkTape = path.join(dir, 'clock.fork.tape');
  const forked = await runExample(
    [cli, 'fork', tape, '--out', forkTape, '--', process.execPath, agent],
    root,
  );
  expect(forked.code, forked.stderr).toBe(0);
  expect(forked.stdout).toBe(recorded.stdout);
  expect(forked.stderr).toContain('0 calls + 1 tools from tape');
  const forkData = await readTape(forkTape);
  expect(forkData.tools[0]?.servedFrom).toEqual({ seq: 0 });
  expect(forkData.tools[0]?.id).toBe(0);
  expect(await readFile(counter, 'utf8')).toBe('1');
  const env = exampleEnv();
  delete env.TAPEDIFF_PROXY_URL;
  expect((await runExample([agent], root, env)).code).toBe(0);
  expect(await readFile(counter, 'utf8')).toBe('2');
  const unused = await runExample(
    [cli, 'test', dir, '--', process.execPath, '-e', ''],
    root,
  );
  expect(unused.code).toBe(1);
  expect(unused.stderr).toContain('1 unused');
  const missAgent = path.join(dir, 'miss.mjs');
  await writeFile(
    missAgent,
    (await readFile(agent, 'utf8')).replace("'clock'", "'other'"),
  );
  const miss = await runExample(
    [cli, 'replay', tape, '--', process.execPath, missAgent],
    root,
  );
  expect(miss.code).toBe(3);
  expect(miss.stderr).toContain('1 misses');
  const tested = await runExample(
    [cli, 'test', dir, '--', process.execPath, missAgent],
    root,
  );
  expect(tested.code).toBe(1);
});

const venv = path.join(
  root,
  'examples/python-openai/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

it('keeps the vendored Python helper identical to the client', async () => {
  expect(
    await readFile(path.join(root, 'examples/python-openai/tapediff_tools.py')),
  ).toEqual(
    await readFile(path.join(root, 'clients/python/tapediff_tools.py')),
  );
});
const python = existsSync(venv) ? venv : 'python';
const probe = spawn.sync(python, ['--version'], { timeout: 10_000 });
const hasPython = !probe.error && probe.status === 0;
if (!hasPython)
  console.warn(
    'SKIP Python tool client: python is unavailable; install Python 3.9+ to enable it.',
  );
it.skipIf(!hasPython)(
  'uses the vendored Python client against the real proxy for record, replay, errors and misses',
  async () => {
    const agent = path.join(dir, 'agent.py');
    await writeFile(
      agent,
      `import sys\nsys.path.insert(0, ${JSON.stringify(path.join(root, 'clients/python'))})
from tapediff_tools import recorded_tool, tool, TapediffToolError, TapediffToolMiss
@recorded_tool()
def add(x):
    return {'value': x + 1}
print(add(x=3))
def fail(args):
    raise ValueError('bad')
try:
    tool('fail', {}, fail)
except (ValueError, TapediffToolError) as error:
    print(str(error))
if len(sys.argv) > 1:
    try:
        tool('missing', {}, lambda args: None)
    except TapediffToolMiss:
        print('miss')
`,
    );
    const tape = path.join(dir, 'python.tape');
    const first = await runExample(
      [cli, 'record', '--out', tape, '--', python, agent],
      root,
    );
    expect(first.code, first.stderr).toBe(0);
    const replay = await runExample(
      [cli, 'replay', tape, '--', python, agent],
      root,
    );
    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.stdout).toBe(first.stdout);
    const miss = await runExample(
      [cli, 'replay', tape, '--', python, agent, 'miss'],
      root,
    );
    expect(miss.code).toBe(3);
    expect(miss.stdout).toContain('miss');
  },
);

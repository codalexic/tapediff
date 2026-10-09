import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';
import { startMock } from '../../examples/_mock/mock-llm.mjs';
import { pythonEnv as environmentForPython } from '../../examples/_mock/python-env.mjs';
import {
  cli,
  exampleEnv,
  root,
  runExample,
} from '../helpers/example-process.js';
import { readTape } from '../../src/tape/io.js';
import { toSteps } from '../../src/steps.js';

const pythonEnv = environmentForPython('python-openai', exampleEnv());
const python = spawn.sync('python', ['-c', 'import openai'], {
  env: pythonEnv,
  timeout: 10_000,
});

const graphEnv = environmentForPython('python-langgraph', exampleEnv());
const graphProbe = spawn.sync(
  'python',
  ['-c', 'import langgraph, langchain_openai'],
  {
    env: graphEnv,
    timeout: 30_000,
  },
);
const hasGraph = !graphProbe.error && graphProbe.status === 0;
if (!hasGraph)
  console.warn(
    'SKIP LangGraph example: install examples/python-langgraph/requirements.txt in its .venv.',
  );

it.skipIf(!hasGraph)(
  'runs the LangGraph README, forks only draft/review and replays tools offline',
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'tapediff-langgraph-'));
    const source = path.join(root, 'examples/python-langgraph');
    const mock = await startMock();
    const liveEnv = {
      ...graphEnv,
      OPENAI_API_KEY: 'tapediff-local-mock',
      OPENAI_BASE_URL: `${mock.url}/v1`,
      TAPEDIFF_OPENAI_UPSTREAM: '',
    };
    const run = (args: string[], env = graphEnv) =>
      runExample([cli, ...args], cwd, env);
    try {
      try {
        const baseOnly: NodeJS.ProcessEnv = { ...liveEnv };
        delete baseOnly.OPENAI_API_BASE;
        const configured = spawn.sync(
          'python',
          [
            '-c',
            'import os; from langchain_openai import ChatOpenAI; client = ChatOpenAI(model="gpt-4.1-nano"); assert str(client.root_client.base_url).rstrip("/") == os.environ["OPENAI_BASE_URL"]',
          ],
          { env: baseOnly, encoding: 'utf8', timeout: 30_000 },
        );
        expect(configured.status, configured.stderr).toBe(0);
        for (const file of ['agent.py', 'agent_v2.py', 'tapediff_tools.py'])
          await copyFile(path.join(source, file), path.join(cwd, file));
        await mkdir(path.join(cwd, 'tapes'));
        const readme = await readFile(path.join(source, 'README.md'), 'utf8');
        const commands = [
          ...readme.matchAll(/```sh\r?\n(tapediff [^\r\n]+)\r?\n```/g),
        ].map((match) => match[1]!.split(' ').slice(1));
        expect(commands.map((args) => args[0])).toEqual([
          'record',
          'show',
          'fork',
          'replay',
        ]);
        const recorded = await run(commands[0]!, liveEnv);
        expect(recorded.code, recorded.stderr).toBe(0);
        expect(recorded.stdout).toContain('executing get_weather');
        expect(recorded.stdout).toContain('executing convert_currency');
        expect(recorded.stdout).toContain('review: FAIL:');
        const baseline = await readTape(path.join(cwd, 'tapes/trip.tape'));
        expect(baseline.exchanges).toHaveLength(5);
        expect(baseline.tools.map((tool) => tool.name)).toEqual([
          'get_weather',
          'convert_currency',
        ]);
        const shown = await run(commands[1]!);
        expect(shown.code, shown.stderr).toBe(0);
        expect(shown.stdout).toMatch(/#4\s+gpt-4.1-nano/);
        const forked = await run(commands[2]!, liveEnv);
        expect(forked.code, forked.stderr).toBe(0);
        expect(forked.stderr).toContain(
          '3 calls + 2 tools from tape · 2 live calls · 0 live tools · saved $0.00006 (375 tokens)',
        );
        expect(forked.stdout).not.toContain('executing');
        expect(forked.stdout).toContain('review: PASS:');
        expect(forked.stdout).toContain('Fahrenheit');
        expect(forked.stdout).toContain('Celsius');
        expect(forked.stdout).toContain('behavior differs');
        const candidate = await readTape(
          path.join(cwd, 'tapes/trip.fork.tape'),
        );
        expect(
          candidate.exchanges.map((call) => Boolean(call.servedFrom)),
        ).toEqual([true, true, true, false, false]);
        expect(candidate.tools.every((tool) => tool.servedFrom)).toBe(true);
        expect(
          candidate.exchanges.slice(0, 3).map((call) => call.response),
        ).toEqual(baseline.exchanges.slice(0, 3).map((call) => call.response));
        expect(candidate.exchanges[3]!.response).not.toEqual(
          baseline.exchanges[3]!.response,
        );
        expect(candidate.exchanges[4]!.response).not.toEqual(
          baseline.exchanges[4]!.response,
        );
        const divergent = await run(
          [
            'fork',
            'tapes/trip.tape',
            '--out',
            'divergence.tape',
            '--',
            'python',
            'agent_v2.py',
          ],
          liveEnv,
        );
        expect(divergent.code, divergent.stderr).toBe(0);
        expect(divergent.stderr).toContain('diverged at call #4');
        expect(divergent.stderr).toContain('3 calls + 2 tools from tape');
      } finally {
        await mock.close();
      }
      const commands = [
        ...(await readFile(path.join(source, 'README.md'), 'utf8')).matchAll(
          /```sh\r?\n(tapediff [^\r\n]+)\r?\n```/g,
        ),
      ];
      const replayArgs = commands[3]![1]!.split(' ').slice(1);
      const replay = await run(replayArgs);
      expect(replay.code, replay.stderr).toBe(0);
      expect(replay.stderr).toContain('5 exchanges · 2 tools · 0 misses');
      expect(replay.stdout).not.toContain('executing');
      expect(replay.stdout).toContain('review: PASS:');
      expect((await run(replayArgs)).stdout).toBe(replay.stdout);
      for (const [tape, agent] of [
        ['tapes/trip.tape', 'agent.py'],
        ['tapes/trip.fork.tape', 'agent_v2.py'],
        ['divergence.tape', 'agent_v2.py'],
      ]) {
        const tested = await run(['test', tape!, '--', 'python', agent!]);
        expect(tested.code, tested.stderr).toBe(0);
        expect(tested.stderr).toContain('PASS');
      }
      const drift = await run([
        'test',
        'tapes/trip.tape',
        '--',
        'python',
        'agent_v2.py',
      ]);
      expect(drift.code).toBe(1);
      expect(drift.stderr).toContain('FAIL');
      for (const [tape, agent] of [
        ['tapes/trip.tape', 'agent.py'],
        ['regressions/trip.fork.tape', 'agent_v2.py'],
      ]) {
        const replay = await runExample(
          [cli, 'replay', tape!, '--', 'python', agent!],
          source,
          graphEnv,
        );
        expect(replay.code, replay.stderr).toBe(0);
        expect(replay.stderr).toContain('5 exchanges · 2 tools · 0 misses');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
const hasPython = !python.error && python.status === 0;
if (!hasPython)
  console.warn(
    'SKIP Python examples: python with the openai package is unavailable. Install examples/python-openai/requirements.txt in .venv to enable them.',
  );

describe.each([
  {
    directory: 'ts-anthropic',
    runtime: 'node',
    extension: 'mjs',
    enabled: true,
  },
  {
    directory: 'python-openai',
    runtime: 'python',
    extension: 'py',
    enabled: hasPython,
  },
])('$directory walkthrough', ({ directory, runtime, extension, enabled }) => {
  const cwd = path.join(root, 'examples', directory);
  const env = runtime === 'python' ? pythonEnv : exampleEnv();

  it.skipIf(!enabled)(
    'runs the exact README walkthrough commands offline',
    async () => {
      const readme = await readFile(path.join(cwd, 'README.md'), 'utf8');
      const commands = [
        ...readme.matchAll(/```sh\r?\n(tapediff [^\r\n]+)\r?\n```/g),
      ].map((match) => match[1]!);
      expect(commands).toHaveLength(7);
      for (const command of commands) {
        // Only substitute the installed executable with the real built CLI; preserve every argument.
        const args = command
          .match(/"[^"]*"|\S+/g)!
          .slice(1)
          .map((arg) => arg.replace(/^"|"$/g, ''));
        const result = await runExample([cli, ...args], cwd, env);
        const regressionTest =
          args[0] === 'test' && command.includes('agent_v2');
        expect(result.code, `${command}\n${result.stderr}`).toBe(
          args[0] === 'diff' || regressionTest ? 1 : 0,
        );
        if (args[0] === 'replay') {
          expect(result.stdout).toContain(
            'Paris: sunny, 22 C. Your 100 USD is 92 EUR.',
          );
          expect(result.stderr).toContain('0 misses');
          expect(result.stderr).not.toContain('never requested');
          expect(result.stdout.match(/tool get_weather:/g)).toHaveLength(
            command.includes('agent_v2') ? 2 : 1,
          );
        } else if (args[0] === 'show') {
          expect(result.stdout).toContain('get_weather');
          expect(result.stdout).toContain('convert_currency');
          expect(result.stdout).toContain('sunny');
        } else if (args[0] === 'diff') {
          expect(result.stdout).toContain('get_weather');
          expect(result.stdout).toContain(
            command.includes('tokyo') ? 'Tokyo' : '+1 added tool call',
          );
        } else {
          expect(
            result.stderr.match(
              new RegExp(regressionTest ? 'FAIL  ' : 'PASS  ', 'g'),
            ),
          ).toHaveLength(2);
          if (!regressionTest)
            expect(result.stdout).toContain(
              'Tokyo: rainy, 18 C. Your 100 USD is 15000 JPY.',
            );
        }
      }
      // Exercise env-only scenario selection separately from the {tape} argument.
      const tokyo = await runExample(
        [
          cli,
          'replay',
          'tapes/tokyo.tape',
          '--',
          runtime,
          `agent.${extension}`,
        ],
        cwd,
        env,
      );
      expect(tokyo.code, tokyo.stderr).toBe(0);
      expect(tokyo.stdout).toContain('Tokyo: rainy');
    },
    90_000,
  );

  it.skipIf(!enabled)(
    'records SDK tool loops through the mock and replays after it closes',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-examples-'));
      const mock = await startMock();
      const recordings: {
        tape: string;
        agent: string;
        scenario: string;
        stdout: string;
      }[] = [];
      try {
        try {
          for (const [scenario, variant] of [
            ['paris', ''],
            ['tokyo', ''],
            ['paris', '_v2'],
          ] as const) {
            const agent = `agent${variant}.${extension}`;
            const tape = path.join(dir, `${scenario}${variant}.tape`);
            const recorded = await runExample(
              [cli, 'record', '--out', tape, '--', runtime, agent, scenario],
              cwd,
              {
                ...env,
                OPENAI_API_KEY: 'tapediff-local-mock',
                ANTHROPIC_API_KEY: 'tapediff-local-mock',
                TAPEDIFF_OPENAI_UPSTREAM: mock.url,
                TAPEDIFF_ANTHROPIC_UPSTREAM: mock.url,
              },
            );
            expect(recorded.code, recorded.stderr).toBe(0);
            const data = await readTape(tape);
            expect(data.header.tapediff).toBe(2);
            expect(data.tools).toHaveLength(variant ? 3 : 2);
            expect(data.exchanges).toHaveLength(variant ? 4 : 3);
            const steps = toSteps(data.exchanges);
            expect(
              steps.filter(
                (step) =>
                  step.kind === 'tool_call' && step.name === 'get_weather',
              ),
            ).toHaveLength(variant ? 2 : 1);
            expect(
              steps.filter(
                (step) =>
                  step.kind === 'tool_call' && step.name === 'convert_currency',
              ),
            ).toHaveLength(1);
            if (runtime === 'node')
              expect(
                data.exchanges.every(
                  (exchange) => (exchange.response.sse?.length ?? 0) > 1,
                ),
              ).toBe(true);
            expect(await readFile(tape, 'utf8')).not.toContain(
              'tapediff-local-mock',
            );
            recordings.push({ tape, agent, scenario, stdout: recorded.stdout });
          }
        } finally {
          await mock.close();
        }
        for (const { tape, agent, scenario, stdout } of recordings) {
          const replay = await runExample(
            [cli, 'replay', tape, '--', runtime, agent, scenario],
            cwd,
            env,
          );
          expect(replay.code, replay.stderr).toBe(0);
          expect(replay.stdout).toBe(stdout);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

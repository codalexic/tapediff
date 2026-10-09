import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';
import { startMock } from '../../examples/_mock/mock-llm.mjs';
import {
  cli,
  exampleEnv,
  root,
  runExample,
} from '../helpers/example-process.js';
import { readTape } from '../../src/tape/io.js';
import { toSteps } from '../../src/steps.js';

const pythonEnv = exampleEnv();
const venvBin = path.join(
  root,
  'examples/python-openai/.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
);
if (
  existsSync(
    path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python'),
  )
) {
  const key =
    Object.keys(pythonEnv).find((name) => name.toLowerCase() === 'path') ??
    'PATH';
  pythonEnv[key] = `${venvBin}${path.delimiter}${pythonEnv[key] ?? ''}`;
}
const python = spawn.sync('python', ['-c', 'import openai'], {
  env: pythonEnv,
  timeout: 10_000,
});
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

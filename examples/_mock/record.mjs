import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import spawn from 'cross-spawn';
import { startMock } from './mock-llm.mjs';
import { pythonEnv } from './python-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env };
const mock = await startMock();
try {
  Object.assign(env, {
    TAPEDIFF_OPENAI_UPSTREAM: mock.url,
    TAPEDIFF_ANTHROPIC_UPSTREAM: mock.url,
    OPENAI_BASE_URL: '',
    OPENAI_API_BASE: '',
    ANTHROPIC_BASE_URL: '',
    OPENAI_API_KEY: 'tapediff-local-mock',
    ANTHROPIC_API_KEY: 'tapediff-local-mock',
    ANTHROPIC_AUTH_TOKEN: '',
    TAPEDIFF_TAPE: '',
    TAPEDIFF_REDACT: '',
    PYTHONUNBUFFERED: '1',
    LANGSMITH_TRACING: 'false',
    LANGCHAIN_TRACING_V2: 'false',
    NO_PROXY: '127.0.0.1,localhost',
  });
  for (const [directory, runtime, extension] of [
    ['python-openai', 'python', 'py'],
    ['ts-anthropic', 'node', 'mjs'],
    ['python-langgraph', 'python', 'py'],
  ]) {
    const cwd = path.join(root, 'examples', directory);
    const childEnv = runtime === 'python' ? pythonEnv(directory, env) : env;
    if (runtime === 'python') {
      const probe = spawn.sync(
        'python',
        [
          '-c',
          directory === 'python-langgraph'
            ? 'import langgraph, langchain_openai'
            : 'import openai',
        ],
        {
          cwd,
          env: childEnv,
          timeout: 30_000,
        },
      );
      if (probe.error || probe.status !== 0) {
        process.stderr.write(
          `SKIP ${directory}: install its requirements.txt in .venv.\n`,
        );
        continue;
      }
    }
    await mkdir(path.join(cwd, 'tapes'), { recursive: true });
    await mkdir(path.join(cwd, 'regressions'), { recursive: true });
    for (const [scenario, variant] of directory === 'python-langgraph'
      ? [
          ['trip', ''],
          ['trip', '_v2'],
        ]
      : [
          ['paris', ''],
          ['tokyo', ''],
          ['paris', '_v2'],
        ]) {
      const tape = variant
        ? `regressions/${scenario}${directory === 'python-langgraph' ? '.fork' : '-v2'}.tape`
        : `tapes/${scenario}.tape`;
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.join(root, 'dist/cli.js'),
            ...(directory === 'python-langgraph' && variant
              ? ['fork', 'tapes/trip.tape', '--at', '4']
              : ['record']),
            '--force',
            ...(directory === 'python-langgraph'
              ? []
              : ['--name', `${directory}: ${scenario}${variant}`]),
            '--out',
            tape,
            '--',
            runtime,
            `agent${variant}.${extension}`,
            ...(directory === 'python-langgraph' ? [] : [scenario]),
          ],
          { cwd, env: childEnv, stdio: 'inherit' },
        );
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(`Recording ${directory}/${tape} failed (${code})`),
              ),
        );
      });
    }
  }
} finally {
  await mock.close();
}

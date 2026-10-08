import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import spawn from 'cross-spawn';
import { startMock } from './mock-llm.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pythonDir = path.join(root, 'examples/python-openai');
const venvBin = path.join(
  pythonDir,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
);
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
  'PATH';
const env = { ...process.env };
try {
  await access(
    path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python'),
  );
  env[pathKey] = `${venvBin}${path.delimiter}${env[pathKey] ?? ''}`;
} catch {
  /* Use python from PATH when no local venv exists. */
}

const probe = spawn.sync('python', ['-c', 'import openai'], {
  cwd: pythonDir,
  env,
  timeout: 10_000,
});
if (probe.error || probe.status !== 0)
  throw new Error(
    'Install Python dependencies first: see examples/python-openai/README.md',
  );
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
    NO_PROXY: '127.0.0.1,localhost',
  });
  for (const [directory, runtime, extension] of [
    ['python-openai', 'python', 'py'],
    ['ts-anthropic', 'node', 'mjs'],
  ]) {
    const cwd = path.join(root, 'examples', directory);
    await mkdir(path.join(cwd, 'tapes'), { recursive: true });
    await mkdir(path.join(cwd, 'regressions'), { recursive: true });
    for (const [scenario, variant] of [
      ['paris', ''],
      ['tokyo', ''],
      ['paris', '_v2'],
    ]) {
      const tape = variant
        ? 'regressions/paris-v2.tape'
        : `tapes/${scenario}.tape`;
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.join(root, 'dist/cli.js'),
            'record',
            '--force',
            '--name',
            `${directory}: ${scenario}${variant}`,
            '--out',
            tape,
            '--',
            runtime,
            `agent${variant}.${extension}`,
            scenario,
          ],
          { cwd, env, stdio: 'inherit' },
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

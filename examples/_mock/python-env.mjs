import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export function pythonEnv(directory, base = process.env) {
  const env = { ...base };
  const bin = fileURLToPath(
    new URL(
      `../${directory}/.venv/${process.platform === 'win32' ? 'Scripts' : 'bin'}/`,
      import.meta.url,
    ),
  );
  if (
    existsSync(
      path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'),
    )
  ) {
    const key =
      Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    env[key] = `${bin}${path.delimiter}${env[key] ?? ''}`;
  }
  return env;
}

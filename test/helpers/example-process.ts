import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const cli = path.join(root, 'dist/cli.js');

export function exampleEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    OPENAI_BASE_URL: '',
    OPENAI_API_BASE: '',
    ANTHROPIC_BASE_URL: '',
    TAPEDIFF_OPENAI_UPSTREAM: 'http://127.0.0.1:1',
    TAPEDIFF_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:1',
    TAPEDIFF_TAPE: '',
    TAPEDIFF_REDACT: '',
    NO_COLOR: '1',
    NO_PROXY: '127.0.0.1,localhost',
    PYTHONUNBUFFERED: '1',
    LANGSMITH_TRACING: 'false',
    LANGCHAIN_TRACING_V2: 'false',
  };
}

export function runExample(
  args: string[],
  cwd: string,
  env = exampleEnv(),
  timeoutMs = 30_000,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd, env });
      let stdout = '',
        stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Example command timed out'));
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
}

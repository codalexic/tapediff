import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(root, 'dist/cli.js'), ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            OPENAI_BASE_URL: '',
            OPENAI_API_BASE: '',
            ANTHROPIC_BASE_URL: '',
            TAPEDIFF_OPENAI_UPSTREAM: '',
            TAPEDIFF_ANTHROPIC_UPSTREAM: '',
            OPENAI_API_KEY: 'sk-proj-fake0123456789abcdefgh',
            ANTHROPIC_API_KEY: 'sk-ant-fake0123456789abcdefgh',
            ...env,
          },
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('CLI timed out'));
      }, 15_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stderr, stdout });
      });
    },
  );
}

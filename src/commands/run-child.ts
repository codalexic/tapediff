import spawn from 'cross-spawn';
import { constants } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { createProxy } from '../proxy/server.js';

export function forwardSignal(
  child: Pick<ChildProcess, 'kill'>,
  signal: 'SIGINT' | 'SIGTERM',
  platform = process.platform,
): void {
  if (platform === 'win32') child.kill();
  else child.kill(signal);
}

/** Run one agent and keep signal forwarding installed through proxy shutdown. */
export async function runChild(
  command: string[],
  proxy: Awaited<ReturnType<typeof createProxy>>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let killTimer: NodeJS.Timeout | undefined;
  let received: 'SIGINT' | 'SIGTERM' | undefined;
  let child: ChildProcess | undefined;
  const forward = (signal: 'SIGINT' | 'SIGTERM') => {
    received = signal;
    if (!child) return;
    forwardSignal(child, signal);
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5_000);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    if (!command[0]) throw new Error('could not start child command');
    child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env: {
        ...env,
        OPENAI_BASE_URL: proxy.baseUrls.openai,
        OPENAI_API_BASE: proxy.baseUrls.openai,
        ANTHROPIC_BASE_URL: proxy.baseUrls.anthropic,
      },
    });
    return await new Promise<number>((resolve, reject) => {
      child!.once('error', () =>
        reject(new Error('could not start child command')),
      );
      child!.once('exit', (code, signal) =>
        resolve(
          received
            ? 128 + constants.signals[received]
            : (code ?? (signal ? 128 + constants.signals[signal] : 1)),
        ),
      );
    });
  } finally {
    try {
      await proxy.close();
    } finally {
      clearTimeout(killTimer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
}

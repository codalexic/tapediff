import path from 'node:path';
import { createProxy } from '../proxy/server.js';
import { loadReplay, type ReplayOptions } from '../proxy/replay.js';
import { redactBody } from '../tape/redact.js';
import { runChild } from './run-child.js';

export async function replayCommand(
  tape: string,
  command: string[],
  options: ReplayOptions = {},
) {
  const replay = await loadReplay(tape, options);
  const proxy = await createProxy({ mode: 'replay', handler: replay.handler });
  const tapePath = path.resolve(tape);
  const childCode = await runChild(
    command.map((arg) => arg.replaceAll('{tape}', tapePath)),
    proxy,
    {
      ...process.env,
      TAPEDIFF_TAPE: tapePath,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'tapediff-replay',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'tapediff-replay',
    },
  );
  const stats = replay.stats;
  if (stats.unconsumed)
    process.stderr.write(
      `warning: ${stats.unconsumed} recorded ${stats.unconsumed === 1 ? 'call was' : 'calls were'} never requested\n`,
    );
  process.stderr.write(
    `replayed ${stats.consumed} exchanges · ${stats.misses} misses · ${stats.fallbacks} fallbacks ← ${redactBody(tape) as string}\n`,
  );
  return { ...stats, childCode, code: stats.misses ? 3 : childCode };
}

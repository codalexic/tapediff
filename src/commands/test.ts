import path from 'node:path';
import { redactBody } from '../tape/redact.js';
import { findTapes } from './find-tapes.js';
import { replayCommand } from './replay.js';

export async function testCommand(
  input: string,
  command: string[],
): Promise<number> {
  const tapes = await findTapes(input);
  if (!tapes.length) throw new Error('no .tape files found');
  const rows: string[] = [];
  let failed = false;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    for (const tape of tapes) {
      const label = redactBody(path.relative(process.cwd(), tape)) as string;
      try {
        const result = await replayCommand(tape, command);
        const drift =
          result.misses > 0 || result.unconsumed > 0 || result.childCode !== 0;
        failed ||= drift;
        rows.push(
          `${drift ? 'FAIL' : 'PASS'}  ${label}  ${result.misses} misses, ${result.unconsumed} unused, child ${result.childCode}`,
        );
      } catch {
        failed = true;
        rows.push(`FAIL  ${label}  could not replay tape or start child`);
      }
      // Child crashes are failures; only a signal received by this process stops the suite.
      if (interrupted) break;
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  process.stderr.write(`\nResult  Tape  Details\n${rows.join('\n')}\n`);
  return failed || interrupted ? 1 : 0;
}

import { CommanderError } from 'commander';
import { createProgram } from './cli-program.js';
import { isTapeVersionError } from './tape/read-or-fail.js';

try {
  await createProgram().parseAsync();
} catch (error: unknown) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    // Only application-defined messages: never echo SDK/native error objects.
    const messages = new Set([
      'output exists; use --force to overwrite',
      'cannot create output',
      'cannot replace output',
      'could not start child command',
      'cannot read tape: missing or invalid tape',
      'cannot find tapes',
      'invalid tape glob',
      'no .tape files found',
      'invalid export endpoint',
      'invalid OTLP export headers',
    ]);
    process.stderr.write(
      `error: ${error instanceof Error && (messages.has(error.message) || isTapeVersionError(error)) ? error.message : 'command failed'}\n`,
    );
    process.exitCode = 2;
  }
}

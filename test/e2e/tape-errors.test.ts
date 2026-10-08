import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { run } from '../helpers/cli.js';
import { header } from '../unit/tape-fixtures.js';

it.each(['show', 'diff', 'replay'])(
  '%s reports tape read and version errors consistently without leaking input',
  async (command) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-read-errors-'));
    const tape = path.join(dir, 'test.tape');
    const args =
      command === 'show'
        ? [command, tape]
        : command === 'diff'
          ? [command, tape, tape]
          : [command, tape, '--', process.execPath, '-e', 'process.exit(99)'];
    try {
      const missing = await run(args);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toBe(
        'error: cannot read tape: missing or invalid tape\n',
      );
      for (const tapediff of [-1, 0, 2]) {
        await writeFile(tape, JSON.stringify({ ...header, tapediff }) + '\n');
        const result = await run(args);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          `error: tape line 1: tape version ${tapediff} is ${tapediff > 1 ? 'newer' : 'older'} than`,
        );
      }
      await writeFile(tape, '{private-input:invalid');
      const corrupt = await run(args);
      expect(corrupt.code).toBe(2);
      expect(corrupt.stderr).toBe(missing.stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

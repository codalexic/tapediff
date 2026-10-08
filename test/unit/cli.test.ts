import { fileURLToPath } from 'node:url';
import path from 'node:path';
import spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';

import { version } from '../../src/version.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawn.sync(
    process.execPath,
    [path.join(root, 'dist', 'cli.js'), ...args],
    {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

describe('built CLI', () => {
  it('prints help with all five commands and the global verbose flag', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: tapediff');
    for (const command of ['record', 'replay', 'diff', 'show', 'test']) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain('--verbose');
  });

  it('prints the package version', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(version);
  });

  it.each([['diff', 'a.tape', 'b.tape', '--tui', '--no-color']])(
    'returns exit 2 for missing tapes with %s --tui',
    (...args) => {
      const result = runCli(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'error: cannot read tape: missing or invalid tape\n',
      );
    },
  );

  it.each(['record', 'replay', 'diff', 'show', 'test'])(
    'prints help for %s',
    (command) => {
      const result = runCli([command, '--help']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Usage: tapediff ${command}`);
    },
  );

  it('reports read errors safely with --verbose', () => {
    const result = runCli(['--verbose', 'diff', 'a.tape', 'b.tape']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'error: cannot read tape: missing or invalid tape\n',
    );
  });

  it.each([
    ['unknown'],
    ['show'],
    ['show', 'run.tape', '--unknown'],
    ['replay', 'run.tape', '--strict', '--loose', '--', 'node'],
    ['replay', 'run.tape', '--pace', 'invalid', '--', 'node'],
  ])('returns the spec usage-error code for %j', (...args) => {
    const result = runCli(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('error:');
  });
});

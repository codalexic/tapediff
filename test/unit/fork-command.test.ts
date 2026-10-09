import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { forkCommand } from '../../src/commands/fork.js';
import { createProxy } from '../../src/proxy/server.js';
import { runChild } from '../../src/commands/run-child.js';
import { fixturePath } from './tape-fixtures.js';
import { readTape } from '../../src/tape/io.js';

vi.mock('../../src/proxy/server.js', () => ({ createProxy: vi.fn() }));
vi.mock('../../src/commands/run-child.js', () => ({ runChild: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('uses exit 3 for proxy shutdown failures and leaves a readable tape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-fork-failure-'));
  try {
    const close = vi.fn().mockRejectedValue(new Error('private error'));
    vi.mocked(createProxy).mockResolvedValue({
      port: 0,
      baseUrls: { openai: '', anthropic: '' },
      close,
    });
    vi.mocked(runChild).mockImplementation(async (_command, proxy) => {
      await proxy.close();
      return 7;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const out = path.join(dir, 'out.tape');
    expect(
      await forkCommand(fixturePath('basic'), ['node'], { out, diff: true }),
    ).toBe(3);
    expect((await readTape(out)).exchanges).toEqual([]);
    expect(stderr).toHaveBeenCalledWith('error: fork proxy failed\n');
    expect(stderr.mock.calls.flat().join('')).not.toContain('private error');
    expect(stdout).toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not replace the child exit code when the requested diff cannot read a tape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-fork-diff-'));
  try {
    const out = path.join(dir, 'out.tape');
    vi.mocked(createProxy).mockResolvedValue({
      port: 0,
      baseUrls: { openai: '', anthropic: '' },
      close: () => Promise.resolve(),
    });
    vi.mocked(runChild).mockImplementation(async () => {
      await unlink(out);
      return 9;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await forkCommand(fixturePath('basic'), ['node'], { out, diff: true }),
    ).toBe(9);
    expect(stderr).toHaveBeenCalledWith('error: cannot compare fork tapes\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

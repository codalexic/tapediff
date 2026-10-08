import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { afterEach, expect, it, vi } from 'vitest';
import { runChild } from '../../src/commands/run-child.js';
import type { createProxy } from '../../src/proxy/server.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGSEGV', 'SIGABRT'] as const)(
  'maps a child death from %s to its actual signal number',
  async (signal) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const close = vi.fn().mockResolvedValue(undefined);
    const proxy = {
      baseUrls: { openai: '', anthropic: '' },
      close,
    } as unknown as Awaited<ReturnType<typeof createProxy>>;
    const result = runChild(['agent'], proxy);
    child.emit('exit', null, signal);
    expect(await result).toBe(128 + constants.signals[signal]);
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'preserves forwarded %s even if Windows reports a termination code',
  async (signal) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const proxy = {
      baseUrls: { openai: '', anthropic: '' },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createProxy>>;
    const result = runChild(['agent'], proxy);
    process.emit(signal);
    child.emit('exit', 1, null);
    expect(await result).toBe(128 + constants.signals[signal]);
  },
);

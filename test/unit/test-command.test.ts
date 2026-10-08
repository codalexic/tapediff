import { afterEach, expect, it, vi } from 'vitest';
import { testCommand } from '../../src/commands/test.js';
import { findTapes } from '../../src/commands/find-tapes.js';
import { replayCommand } from '../../src/commands/replay.js';

vi.mock('../../src/commands/find-tapes.js', () => ({ findTapes: vi.fn() }));
vi.mock('../../src/commands/replay.js', () => ({ replayCommand: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([130, 143])(
  'continues the suite when a child exits %i without user interruption',
  async (childCode) => {
    vi.mocked(findTapes).mockResolvedValue(['a.tape', 'b.tape']);
    vi.mocked(replayCommand).mockResolvedValue({
      childCode,
      code: childCode,
      requests: 0,
      misses: 0,
      fallbacks: 0,
      consumed: 0,
      unconsumed: 0,
    });
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await testCommand('.', ['agent'])).toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('b.tape'));
  },
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'stops only after receiving %s and removes listeners',
  async (signal) => {
    vi.mocked(findTapes).mockResolvedValue(['a.tape', 'b.tape']);
    const listeners = process.listenerCount(signal);
    vi.mocked(replayCommand).mockImplementation(() => {
      process.emit(signal);
      return Promise.resolve({
        childCode: 0,
        code: 0,
        requests: 0,
        misses: 0,
        fallbacks: 0,
        consumed: 0,
        unconsumed: 0,
      });
    });
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await testCommand('.', ['agent'])).toBe(1);
    expect(output).not.toHaveBeenCalledWith(expect.stringContaining('b.tape'));
    expect(process.listenerCount(signal)).toBe(listeners);
  },
);

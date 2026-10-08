import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TapeWriter } from '../../src/tape/io.js';
import { exchange, header } from './tape-fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

const file = {
  writeFile: vi.fn<(data: string, encoding: string) => Promise<void>>(),
  sync: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
};

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.resetAllMocks();
  file.writeFile.mockResolvedValue(undefined);
  file.sync.mockResolvedValue(undefined);
  file.close.mockResolvedValue(undefined);
  // Only the FileHandle operations used by TapeWriter need a simulated disk.
  vi.mocked(open).mockResolvedValue(file as unknown as FileHandle);
});

describe('durability and disk failures', () => {
  it('waits for fsync before an append resolves', async () => {
    const writer = await TapeWriter.open('unused.tape', header, []);
    let release!: () => void;
    file.sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const append = writer.appendExchange(exchange).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(file.sync).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    release();
    await append;
    expect(settled).toBe(true);
    await writer.close();
    expect(file.writeFile).toHaveBeenCalledTimes(2);
    expect(file.close).toHaveBeenCalledTimes(1);
  });

  it.each(['writeFile', 'sync'] as const)(
    'closes the file when the header %s fails',
    async (operation) => {
      file[operation].mockRejectedValueOnce(new Error('disk full'));
      await expect(TapeWriter.open('unused.tape', header, [])).rejects.toThrow(
        'disk full',
      );
      expect(file.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['writeFile', 'sync'] as const)(
    'stops the append queue after %s failure and still closes',
    async (operation) => {
      const writer = await TapeWriter.open('unused.tape', header, []);
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      file[operation].mockRejectedValueOnce(new Error('disk full'));
      const first = writer.appendExchange(exchange);
      const second = writer.appendExchange({ ...exchange, id: 1 });
      const closing = writer.close();
      const results = await Promise.allSettled([first, second, closing]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(String(result.reason)).toContain('disk full');
      }
      expect(file.writeFile).toHaveBeenCalledTimes(2);
      expect(file.close).toHaveBeenCalledTimes(1);
      await expect(writer.appendExchange(exchange)).rejects.toThrow('closed');
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'warning: failed to append tape exchange; recording may be incomplete',
      );
    },
  );
});

it('warns once for invalid exchanges without exposing their contents', async () => {
  const writer = await TapeWriter.open('unused.tape', header, []);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    for (let i = 0; i < 2; i++)
      await expect(
        writer.appendExchange({ ...exchange, id: -1 }),
      ).rejects.toThrow('invalid tape exchange');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'warning: failed to append tape exchange; recording may be incomplete',
    );
  } finally {
    await writer.close();
  }
});

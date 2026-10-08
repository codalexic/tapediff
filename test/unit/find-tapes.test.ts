import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { findTapes } from '../../src/commands/find-tapes.js';

it('finds sorted tapes recursively and supports portable glob segments without including other files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-glob-'));
  try {
    await mkdir(path.join(dir, 'nested'));
    const names = ['z.tape', 'a.tape', 'b.tape', 'a.json', 'nested/c.tape'];
    await Promise.all(names.map((name) => writeFile(path.join(dir, name), '')));
    const full = (names: string[]) =>
      names.map((name) => path.join(dir, name)).sort();
    expect(await findTapes(dir)).toEqual(
      full(['a.tape', 'b.tape', 'z.tape', 'nested/c.tape']),
    );
    expect(await findTapes(path.join(dir, '*.tape'))).toEqual(
      full(['a.tape', 'b.tape', 'z.tape']),
    );
    expect(await findTapes(path.join(dir, '**', '?.tape'))).toEqual(
      await findTapes(dir),
    );
    expect(await findTapes(path.join(dir, '[ab].tape'))).toEqual(
      full(['a.tape', 'b.tape']),
    );
    expect(await findTapes(path.join(dir, '[!ab].tape'))).toEqual(
      full(['z.tape']),
    );
    expect(await findTapes(path.join(dir, 'a.tape'))).toEqual(full(['a.tape']));
    expect(await findTapes(path.join(dir, 'missing', '**', '*.tape'))).toEqual(
      [],
    );
    expect(await findTapes(path.join(dir, 'a.json'))).toEqual([]);
    await expect(findTapes(path.join(dir, '[invalid.tape'))).rejects.toThrow(
      'invalid tape glob',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

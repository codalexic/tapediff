import { open, unlink } from 'node:fs/promises';

export async function createOutputFile(path: string, force = false) {
  if (force) {
    try {
      await unlink(path);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw new Error('cannot replace output', { cause: error });
    }
  }
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('output exists; use --force to overwrite', {
        cause: error,
      });
    throw new Error('cannot create output', { cause: error });
  }
}

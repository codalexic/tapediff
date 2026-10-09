import { unlink } from 'node:fs/promises';
import { TapeWriter } from '../tape/io.js';
import type { TapeHeader } from '../tape/schema.js';

export async function openOutputTape(
  out: string,
  header: TapeHeader,
  force = false,
): Promise<TapeWriter> {
  if (force) {
    try {
      await unlink(out);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw new Error('cannot replace output tape', { cause: error });
    }
  }
  let writer: TapeWriter;
  try {
    writer = await TapeWriter.open(out, header);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('output tape exists; use --force to overwrite', {
        cause: error,
      });
    throw new Error('cannot create output tape', { cause: error });
  }
  return writer;
}

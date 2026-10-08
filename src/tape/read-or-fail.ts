import { readTape } from './io.js';

/** Only our version diagnostics are safe to expose verbatim at the CLI boundary. */
export function isTapeVersionError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^tape line 1: tape version -?\d+ is (newer|older) than/.test(error.message)
  );
}

export async function readTapeOrFail(
  path: string,
): ReturnType<typeof readTape> {
  try {
    return await readTape(path);
  } catch (error) {
    if (isTapeVersionError(error)) throw error;
    throw new Error('cannot read tape: missing or invalid tape', {
      cause: error,
    });
  }
}

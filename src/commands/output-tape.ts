import { createOutputFile } from './output-file.js';
import { TapeWriter } from '../tape/io.js';
import type { TapeHeader } from '../tape/schema.js';

export async function openOutputTape(
  out: string,
  header: TapeHeader,
  force = false,
): Promise<TapeWriter> {
  const file = await createOutputFile(out, force);
  try {
    return await TapeWriter.open(file, header);
  } catch (error) {
    await file.close();
    throw new Error('cannot create output', { cause: error });
  }
}

import type { IncomingMessage } from 'node:http';
import type { JsonValue } from '../tape/schema.js';

export function parseBody(text: string): JsonValue {
  if (!text) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/** Record and replay must decode exactly the same bytes before normalization. */
export async function readRequestBody(request: IncomingMessage) {
  const buffers: Buffer[] = [];
  for await (const chunk of request)
    buffers.push(Buffer.from(chunk as Uint8Array));
  const bytes = Buffer.concat(buffers);
  return { bytes, body: parseBody(bytes.toString('utf8')) };
}

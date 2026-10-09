import { z } from 'zod';

export const TAPE_VERSION = 1;
export const providerSchema = z.enum(['openai', 'anthropic', 'unknown']);
export type Provider = z.infer<typeof providerSchema>;
export const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;

const timestamp = z.iso.datetime({ offset: true });
const nonnegative = z.number().nonnegative();
const count = z.number().int().nonnegative();
const headers = z.record(z.string(), z.string());

/** First JSONL record identifying the tape format and recording command. */
export const tapeHeaderSchema = z.object({
  tapediff: z.literal(TAPE_VERSION),
  createdAt: timestamp,
  name: z.string().optional(),
  command: z.array(z.string()),
  forkedFrom: z
    .object({
      tape: z.string(),
      at: z.number().int().min(1).nullable(),
      mode: z.enum(['divergence', 'positional']),
      sourceCreatedAt: timestamp,
    })
    .optional(),
  tool: z.object({ name: z.literal('tapediff'), version: z.string() }),
});
export type TapeHeader = z.infer<typeof tapeHeaderSchema>;

/** Raw SSE bytes decoded as text, with milliseconds since response start. */
export const sseChunkSchema = z.object({ t: nonnegative, data: z.string() });
export type SseChunk = z.infer<typeof sseChunkSchema>;

/** One recorded request and its JSON, text, empty, or streaming response. */
export const exchangeSchema = z.object({
  id: count,
  seq: count,
  provider: providerSchema,
  endpoint: z.string().startsWith('/'),
  request: z.object({
    method: z.string().min(1),
    path: z.string().startsWith('/'),
    headers,
    body: jsonSchema,
  }),
  matchKey: z.string().regex(/^[a-f0-9]{64}$/, 'expected a SHA-256 hex digest'),
  looseKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'expected a SHA-256 hex digest')
    .optional(),
  response: z.object({
    status: z.number().int().min(100).max(599),
    headers,
    body: jsonSchema.optional(),
    sse: z.array(sseChunkSchema).optional(),
  }),
  timing: z.object({ startedAt: timestamp, latencyMs: nonnegative }),
  usage: z
    .object({
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count.optional(),
      cacheWriteTokens: count.optional(),
    })
    .optional(),
  model: z.string().optional(),
  costUsd: nonnegative.nullable().optional(),
  aborted: z.boolean().optional(),
  servedFrom: z.object({ seq: count }).optional(),
});
export type Exchange = z.infer<typeof exchangeSchema>;

/** Syntax error distinguished from schema corruption when recovering a crash. */
export class TapeSyntaxError extends Error {
  constructor(
    line: number,
    public readonly incomplete: boolean,
  ) {
    super(
      `tape line ${line}: invalid JSON${incomplete ? ' (incomplete record)' : ''}`,
    );
    this.name = 'TapeSyntaxError';
  }
}

/** Validate a decoded record without echoing potentially sensitive input. */
export function validateTapeRecord(value: unknown, line: 1): TapeHeader;
export function validateTapeRecord(
  value: unknown,
  line: number,
): TapeHeader | Exchange;
export function validateTapeRecord(
  value: unknown,
  line: number,
): TapeHeader | Exchange {
  if (
    line === 1 &&
    typeof value === 'object' &&
    value !== null &&
    'tapediff' in value
  ) {
    const version = value.tapediff;
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version !== TAPE_VERSION
    ) {
      const advice =
        version > TAPE_VERSION
          ? `tape version ${version} is newer than this tapediff supports; upgrade`
          : `tape version ${version} is older than this tapediff supports; re-record with tape version ${TAPE_VERSION}`;
      throw new Error(`tape line ${line}: ${advice}`);
    }
  }
  const result = (line === 1 ? tapeHeaderSchema : exchangeSchema).safeParse(
    value,
  );
  if (!result.success) {
    // Zod paths can contain arbitrary body keys; never include those keys in logs.
    const issues = result.error.issues.map((issue) => {
      const field = issue.path[0];
      return `${typeof field === 'string' ? field : 'record'}: ${issue.message}`;
    });
    throw new Error(`tape line ${line}: ${issues.join('; ')}`);
  }
  return result.data;
}

/** Parse a JSONL record; physical line 1 is always the tape header. */
export function parseTapeLine(text: string, line: 1): TapeHeader;
export function parseTapeLine(
  text: string,
  line: number,
): TapeHeader | Exchange;
export function parseTapeLine(
  text: string,
  line: number,
): TapeHeader | Exchange {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // Node >=20 reports EOF separately from invalid tokens. Do not expose its
    // original message, which may quote secret-bearing input.
    const message = error instanceof SyntaxError ? error.message : '';
    const incomplete =
      /Unexpected end of JSON input|Unterminated string in JSON/.test(
        message,
      ) || /at position (\d+)/.exec(message)?.[1] === String(text.length);
    throw new TapeSyntaxError(line, incomplete);
  }
  return validateTapeRecord(value, line);
}

import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  exchangeSchema,
  toolRecordSchema,
  TAPE_VERSION,
  parseTapeLine,
  TapeSyntaxError,
  validateTapeRecord,
} from './schema.js';
import type { Exchange, TapeHeader, ToolRecord } from './schema.js';
import {
  parseRedactPatterns,
  redactBody,
  redactHeaders,
  redactSse,
} from './redact.js';
import type { RedactPattern } from './redact.js';

/** An exclusively created JSONL tape, with serialized, durable append operations. */
export class TapeWriter {
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private warned = false;

  private constructor(
    private readonly file: FileHandle,
    private readonly patterns: readonly RedactPattern[],
  ) {}

  /** Create a new tape and fsync its redacted header; never overwrite an existing tape. */
  static async open(
    path: string,
    header: TapeHeader,
    extraPatterns: readonly RedactPattern[] = parseRedactPatterns(
      process.env.TAPEDIFF_REDACT,
    ),
  ): Promise<TapeWriter> {
    const patterns = [...extraPatterns];
    const clean = validateTapeRecord(
      {
        ...header,
        tapediff: TAPE_VERSION,
        command: redactBody(header.command, patterns),
        ...(header.forkedFrom
          ? {
              forkedFrom: {
                ...header.forkedFrom,
                tape: redactBody(header.forkedFrom.tape, patterns),
              },
            }
          : {}),
      },
      1,
    );
    const file = await open(path, 'wx', 0o600);
    const writer = new TapeWriter(file, patterns);
    try {
      await writer.writeLine(clean);
      return writer;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** Redact and append one exchange; resolution means this write has been fsynced. */
  appendExchange(exchange: Exchange): Promise<void> {
    if (this.closing) {
      this.warnAppendFailure();
      return Promise.reject(new Error('tape writer is closed'));
    }
    // Snapshot before enqueueing, so caller mutation cannot change queued bytes.
    let clean: Exchange;
    try {
      const redacted = {
        ...exchange,
        request: {
          ...exchange.request,
          headers: redactHeaders(exchange.request.headers, this.patterns),
          body: redactBody(exchange.request.body, this.patterns),
        },
        response: {
          ...exchange.response,
          headers: redactHeaders(exchange.response.headers, this.patterns),
          ...(exchange.response.body === undefined
            ? {}
            : { body: redactBody(exchange.response.body, this.patterns) }),
          ...(exchange.response.sse === undefined
            ? {}
            : { sse: redactSse(exchange.response.sse, this.patterns) }),
        },
      };
      clean = exchangeSchema.parse(redacted);
    } catch {
      this.warnAppendFailure();
      // Never surface Zod diagnostics quoting secret-bearing input.
      return Promise.reject(new Error('cannot append invalid tape exchange'));
    }
    const write = this.pending
      .then(() => this.writeLine(clean))
      .catch((error: unknown) => {
        this.warnAppendFailure();
        throw error;
      });
    // Retain failure: once a write fails, no later append may extend a partial line.
    this.pending = write;
    return write;
  }

  /** Redact and durably append a tool, snapshotting it before enqueueing. */
  appendTool(record: ToolRecord): Promise<void> {
    if (this.closing) {
      this.warnAppendFailure();
      return Promise.reject(new Error('tape writer is closed'));
    }
    let clean: ToolRecord;
    try {
      record = toolRecordSchema.parse(record);
      clean = toolRecordSchema.parse({
        ...record,
        name: redactBody(record.name, this.patterns),
        args: redactBody(record.args, this.patterns),
        ...(record.result === undefined
          ? {}
          : { result: redactBody(record.result, this.patterns) }),
        ...(record.error
          ? { error: redactBody(record.error, this.patterns) }
          : {}),
      });
    } catch {
      this.warnAppendFailure();
      return Promise.reject(new Error('cannot append invalid tape tool'));
    }
    this.pending = this.pending
      .then(() => this.writeLine(clean))
      .catch((error: unknown) => {
        this.warnAppendFailure();
        throw error;
      });
    return this.pending;
  }

  /** Finish queued writes and close the handle, even after a failed append. */
  close(): Promise<void> {
    this.closing ??= this.pending.finally(() => this.file.close());
    return this.closing;
  }

  private async writeLine(
    value: TapeHeader | Exchange | ToolRecord,
  ): Promise<void> {
    await this.file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await this.file.sync();
  }

  private warnAppendFailure(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      'warning: failed to append tape exchange; recording may be incomplete',
    );
  }
}

/** Read and validate every physical line, recovering only a final EOF-truncated exchange. */
export async function readTape(
  path: string,
): Promise<{ header: TapeHeader; exchanges: Exchange[]; tools: ToolRecord[] }> {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');
  const terminated = text.endsWith('\n');
  if (terminated) lines.pop();
  const header = parseTapeLine(lines[0] ?? '', 1);
  const exchanges: Exchange[] = [];
  const tools: ToolRecord[] = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const record = parseTapeLine(lines[index]!, index + 1);
      if ('kind' in record) tools.push(record);
      else exchanges.push(record as Exchange);
    } catch (error) {
      if (
        !terminated &&
        index === lines.length - 1 &&
        error instanceof TapeSyntaxError &&
        error.incomplete
      ) {
        console.warn(`tape line ${index + 1}: ignoring truncated final line`);
      } else {
        throw error;
      }
    }
  }
  exchanges.sort((a, b) => a.seq - b.seq);
  tools.sort((a, b) => a.seq - b.seq);
  return { header, exchanges, tools };
}

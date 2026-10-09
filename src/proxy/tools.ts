import { createHash, randomUUID } from 'node:crypto';
import { nearestDiff } from './nearest-diff.js';
import { z } from 'zod';
import { canonicalJson } from '../tape/normalize.js';
import { jsonSchema, type JsonValue, type ToolRecord } from '../tape/schema.js';
import { parseRedactPatterns, redactBody } from '../tape/redact.js';
import type { TapeWriter } from '../tape/io.js';
import type { ProxyContext, ProxyHandler } from './server.js';
import { readRequestBody } from './body.js';

export const isToolRoute = (path: string) => path.startsWith('/tapediff/v1/');

export function toolMatchKey(name: string, args: JsonValue): string {
  return createHash('sha256')
    .update(canonicalJson({ name, args }))
    .digest('hex');
}

const startSchema = z.object({ name: z.string().min(1), args: jsonSchema });
const finishSchema = z
  .object({
    id: z.string().min(1),
    result: jsonSchema.optional(),
    undefined: z.literal(true).optional(),
    error: z
      .object({ name: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .refine(
    (value) => (value.result !== undefined) !== (value.error !== undefined),
  )
  .refine((value) => !value.undefined || value.result === null);

export function toolMissDiff(
  name: string,
  args: JsonValue,
  candidates: readonly ToolRecord[],
): string {
  return nearestDiff(
    args,
    candidates
      .filter((candidate) => candidate.name === name)
      .map((candidate) => candidate.args),
    {
      recorded: 'recorded args',
      incoming: 'incoming args',
      missing: 'No unconsumed recorded tool with this name.\nIncoming args:\n',
    },
  );
}

export function createToolHandler(options: {
  mode: 'record' | 'replay' | 'fork';
  tools?: readonly ToolRecord[];
  writer?: Pick<TapeWriter, 'appendTool'>;
  isLive?: () => boolean;
  diverge?: (name: string) => void;
  warn?: (message: string) => void;
}) {
  const warn =
    options.warn ?? ((message: string) => process.stderr.write(message));
  const ordered = [...(options.tools ?? [])].sort((a, b) => a.seq - b.seq);
  const consumed = new Set<ToolRecord>();
  const queues = new Map<string, ToolRecord[]>();
  for (const record of ordered) {
    const queue = queues.get(record.matchKey) ?? [];
    queue.push(record);
    queues.set(record.matchKey, queue);
  }
  const pending = new Map<
    string,
    { record: Omit<ToolRecord, 'result' | 'error'>; started: number }
  >();
  let misses = 0;
  let recorded = 0;
  const unused = () => ordered.filter((record) => !consumed.has(record));
  const send = ({ response }: ProxyContext, status: number, body?: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const bad = (context: ProxyContext, message: string) =>
    send(context, 400, { error: { message } });
  const handler: ProxyHandler = async (context) => {
    if (context.request.method !== 'POST') return bad(context, 'expected POST');
    let value: unknown;
    try {
      const { bytes } = await readRequestBody(context.request);
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return bad(context, 'expected valid JSON');
    }
    const route = context.path.split('?')[0];
    if (route === '/tapediff/v1/tools/start') {
      const parsed = startSchema.safeParse(value);
      if (!parsed.success)
        return bad(context, 'expected a nonempty name and JSON args');
      const { name, args } = parsed.data;
      const matchKey = toolMatchKey(name, args);
      const source =
        options.mode !== 'record' && !options.isLive?.()
          ? queues.get(matchKey)?.shift()
          : undefined;
      if (source) {
        consumed.add(source);
        if (options.writer)
          await options.writer.appendTool({
            ...source,
            id: context.seq,
            seq: context.seq,
            name,
            args,
            matchKey,
            timing: { ...source.timing, startedAt: context.startedAt },
            servedFrom: { seq: source.seq },
          });
        return send(context, 200, {
          action: 'replay',
          ...(source.error
            ? { error: source.error }
            : {
                result: source.result,
                ...(source.undefined ? { undefined: true } : {}),
              }),
        });
      }
      if (options.mode === 'replay') {
        misses++;
        const message = redactBody(
          `No recorded match for tool ${name}`,
          parseRedactPatterns(process.env.TAPEDIFF_REDACT),
        ) as string;
        warn(`replay miss: ${message}\n${toolMissDiff(name, args, unused())}`);
        return send(context, 409, {
          error: { type: 'tapediff_tool_miss', message },
        });
      }
      if (!options.isLive?.()) options.diverge?.(name);
      const id = randomUUID();
      pending.set(id, {
        started: context.started,
        record: {
          kind: 'tool',
          id: context.seq,
          seq: context.seq,
          name,
          args,
          matchKey,
          timing: { startedAt: context.startedAt, latencyMs: 0 },
        },
      });
      return send(context, 200, { action: 'run', id });
    }
    if (route === '/tapediff/v1/tools/finish') {
      const parsed = finishSchema.safeParse(value);
      if (!parsed.success)
        return bad(
          context,
          'expected id and exactly one JSON result or error with name and message',
        );
      const { id, result, error } = parsed.data;
      const entry = pending.get(id);
      if (!entry) return bad(context, 'unknown or already finished tool id');
      pending.delete(id);
      if (!options.writer) throw new Error('tool recording requires a writer');
      await options.writer.appendTool({
        ...entry.record,
        ...(error
          ? { error }
          : { result, ...(parsed.data.undefined ? { undefined: true } : {}) }),
        timing: {
          ...entry.record.timing,
          latencyMs: Math.max(0, performance.now() - entry.started),
        },
      });
      recorded++;
      return send(context, 204);
    }
    return bad(context, 'unknown reserved route');
  };
  return {
    handler,
    close() {
      if (pending.size)
        warn(
          `warning: ${pending.size} unfinished tool call(s); no results recorded\n`,
        );
      pending.clear();
    },
    get stats() {
      return {
        consumed: consumed.size,
        unconsumed: unused().length,
        misses,
        recorded,
      };
    },
  };
}

import { createHash } from 'node:crypto';
import type { Exchange, TapeHeader, ToolRecord } from '../tape/schema.js';
import { canonicalJson } from '../tape/normalize.js';
import { inspectExchange } from '../steps.js';
import { chatStream } from '../steps/streams.js';
import { chatOutput, list } from '../steps/content.js';
import { responseMetadata } from '../steps/response-metadata.js';
import { modelOf, object } from '../providers/usage.js';
import { stepTotals } from '../totals.js';
import { version } from '../version.js';
import { inputMessages, outputParts, systemInstructions } from './content.js';

export interface ExportOptions {
  includeContent?: boolean;
  serviceName?: string;
}
export interface Tape {
  header: TapeHeader;
  exchanges: Exchange[];
  tools: ToolRecord[];
}
type Value =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: Value[] } };
interface Attribute {
  key: string;
  value: Value;
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number };
  events?: { name: string; timeUnixNano: string; attributes: Attribute[] }[];
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const str = (key: string, value: string): Attribute => ({
  key,
  value: { stringValue: value },
});
const int = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(value) },
});
const cost = (value: number): Attribute => ({
  key: 'tapediff.cost_usd',
  value: { doubleValue: value },
});

function nanos(date: string): bigint {
  const fraction = /\.(\d+)/.exec(date)?.[1] ?? '';
  const seconds = date.replace(/\.\d+/, '');
  return (
    BigInt(Date.parse(seconds)) * 1_000_000n +
    BigInt(fraction.padEnd(9, '0').slice(0, 9))
  );
}
function times(timing: Exchange['timing']) {
  const start = nanos(timing.startedAt);
  return {
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(
      start + BigInt(Math.round(timing.latencyMs * 1_000_000)),
    ),
  };
}

type InspectedExchange = ReturnType<typeof inspectRecord>;
type ToolCall = InspectedExchange['calls'][number];
type ToolLinks = ReadonlyMap<ToolRecord, ToolCall>;
interface TraceContext {
  traceId: string;
  rootId: string;
}

function inspectRecord(exchange: Exchange) {
  const info = inspectExchange(exchange);
  return {
    exchange,
    ...info,
    calls: info.output.filter((step) => step.kind === 'tool_call'),
  };
}

function linkTools(
  tools: readonly ToolRecord[],
  inspected: readonly InspectedExchange[],
): ToolLinks {
  const calls = inspected.flatMap(({ exchange, calls }) =>
    calls.map((call) => ({ call, seq: exchange.seq })),
  );
  const candidates = new Map(
    tools.map((tool) => [
      tool,
      calls.filter(
        ({ call, seq }) =>
          seq < tool.seq &&
          call.name === tool.name &&
          canonicalJson(call.args) === canonicalJson(tool.args),
      ),
    ]),
  );
  const linked = new Map<ToolRecord, ToolCall>();
  for (const [tool, matches] of candidates) {
    const match = matches[0];
    // Both directions must be unique; repeated arguments cannot establish identity.
    if (
      matches.length === 1 &&
      match &&
      [...candidates.values()].filter((others) => others.includes(match))
        .length === 1
    )
      linked.set(tool, match.call);
  }
  return linked;
}

function childSpan(
  record: Exchange | ToolRecord,
  context: TraceContext,
  name: string,
): Span {
  const tool = 'kind' in record;
  return {
    traceId: context.traceId,
    spanId: hash(
      context.traceId + record.seq + (tool ? 'tool' : 'exchange'),
    ).slice(0, 16),
    parentSpanId: context.rootId,
    name,
    kind: tool ? 1 : 3,
    ...times(record.timing),
    attributes: [],
    status: { code: 0 },
  };
}

function exchangeError(exchange: Exchange): string | undefined {
  if (exchange.aborted) return 'aborted';
  if (exchange.response.status >= 400) return String(exchange.response.status);
  return undefined;
}

function servedAttributes(record: Exchange | ToolRecord): Attribute[] {
  return record.servedFrom
    ? [int('tapediff.served_from_seq', record.servedFrom.seq)]
    : [];
}

function unknownRouteSpan(exchange: Exchange, context: TraceContext): Span {
  const span = childSpan(
    exchange,
    context,
    `${exchange.request.method} ${exchange.endpoint}`,
  );
  const error = exchangeError(exchange);
  span.status.code = error === undefined ? 0 : 2;
  span.attributes = [
    ...(error === undefined ? [] : [str('error.type', error)]),
    str('http.request.method', exchange.request.method),
    int('http.response.status_code', exchange.response.status),
  ];
  return span;
}

function toolSpan(
  record: ToolRecord,
  context: TraceContext,
  call: ToolCall | undefined,
): Span {
  const span = childSpan(record, context, `execute_tool ${record.name}`);
  span.attributes = [
    str('gen_ai.operation.name', 'execute_tool'),
    str('gen_ai.tool.name', record.name),
    ...(call?.id ? [str('gen_ai.tool.call.id', call.id)] : []),
    ...(record.error ? [str('error.type', record.error.name || 'Error')] : []),
    ...servedAttributes(record),
  ];
  span.status.code = record.error ? 2 : 0;
  return span;
}

function chatAttributes(info: InspectedExchange): Attribute[] {
  const { exchange, call, usage, events } = info;
  const metadata = responseMetadata(exchange, events);
  const model = modelOf(exchange.request.body) ?? exchange.model;
  const error = exchangeError(exchange);
  const attributes = [
    ...(error === undefined ? [] : [str('error.type', error)]),
    str('gen_ai.operation.name', 'chat'),
    str('gen_ai.provider.name', exchange.provider),
  ];
  if (model !== undefined) attributes.push(str('gen_ai.request.model', model));
  if (metadata.model !== undefined)
    attributes.push(str('gen_ai.response.model', metadata.model));
  if (metadata.id !== undefined)
    attributes.push(str('gen_ai.response.id', metadata.id));
  if (metadata.finishReasons.length)
    attributes.push({
      key: 'gen_ai.response.finish_reasons',
      value: {
        arrayValue: {
          values: metadata.finishReasons.map((stringValue) => ({
            stringValue,
          })),
        },
      },
    });
  // Anthropic reports cached input separately; OpenAI already includes it.
  const inputTokens =
    call.inputTokens +
    (exchange.provider === 'anthropic'
      ? (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
      : 0);
  attributes.push(
    int('gen_ai.usage.input_tokens', inputTokens),
    int('gen_ai.usage.output_tokens', call.outputTokens),
  );
  if (call.costUsd !== null) attributes.push(cost(call.costUsd));
  return attributes;
}

function toolCallEvents(
  calls: readonly ToolCall[],
  linked: ToolLinks,
  timeUnixNano: string,
): Span['events'] {
  const unrecorded = calls.filter(
    (call) => ![...linked.values()].includes(call),
  );
  return unrecorded.length
    ? unrecorded.map((call) => ({
        name: 'gen_ai.tool.call',
        timeUnixNano,
        attributes: [
          str('gen_ai.tool.name', call.name),
          ...(call.id ? [str('gen_ai.tool.call.id', call.id)] : []),
        ],
      }))
    : undefined;
}

function streamChoices(events: InspectedExchange['events']) {
  const indices = [
    ...new Set(
      events.flatMap((event) =>
        list(event.choices).map((value, index) =>
          typeof object(value).index === 'number'
            ? (object(value).index as number)
            : index,
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  return indices.map((index) =>
    chatStream(
      events.map((event) => ({
        ...event,
        choices: list(event.choices).filter(
          (value, position) => (object(value).index ?? position) === index,
        ),
      })),
    ),
  );
}

function contentAttributes(info: InspectedExchange): Attribute[] {
  const { exchange, events, output } = info;
  const attributes = [
    str('gen_ai.input.messages', JSON.stringify(inputMessages(exchange))),
  ];
  const instructions = systemInstructions(exchange);
  if (instructions.length)
    attributes.push(
      str('gen_ai.system_instructions', JSON.stringify(instructions)),
    );
  let outputs = [output];
  if (
    exchange.provider === 'openai' &&
    !exchange.endpoint.split('?')[0]?.endsWith('/responses')
  ) {
    outputs = exchange.response.sse
      ? streamChoices(events)
      : list(object(exchange.response.body).choices).map((value) =>
          chatOutput(object(value).message),
        );
  }
  attributes.push(
    str(
      'gen_ai.output.messages',
      JSON.stringify(
        outputs
          .filter((output) => output.length)
          .map((output) => ({ role: 'assistant', parts: outputParts(output) })),
      ),
    ),
  );
  return attributes;
}

function chatSpan(
  info: InspectedExchange,
  context: TraceContext,
  linked: ToolLinks,
  includeContent: boolean,
): Span {
  const model = modelOf(info.exchange.request.body) ?? info.exchange.model;
  const span = childSpan(
    info.exchange,
    context,
    model ? `chat ${model}` : 'chat',
  );
  span.attributes = [
    ...chatAttributes(info),
    ...(includeContent ? contentAttributes(info) : []),
    ...servedAttributes(info.exchange),
  ];
  span.status.code = exchangeError(info.exchange) === undefined ? 0 : 2;
  const events = toolCallEvents(info.calls, linked, span.endTimeUnixNano);
  if (events) span.events = events;
  return span;
}

function rootAttributes(
  header: TapeHeader,
  inspected: readonly InspectedExchange[],
): Attribute[] {
  const totals = stepTotals(
    inspected
      .filter(({ exchange }) => exchange.provider !== 'unknown')
      .sort((a, b) => a.exchange.seq - b.exchange.seq)
      .map(({ call }) => call),
  );
  const attributes = [
    int('tapediff.tape.version', header.tapediff),
    int('tapediff.usage.input_tokens', totals.inputTokens),
    int('tapediff.usage.output_tokens', totals.outputTokens),
    int('tapediff.usage.total_tokens', totals.tokens),
  ];
  if (header.name !== undefined)
    attributes.push(str('tapediff.tape.name', header.name));
  if (totals.costUsd !== null) attributes.push(cost(totals.costUsd));
  const fork = header.forkedFrom;
  if (fork) {
    attributes.push(
      str('tapediff.forked_from.tape', fork.tape),
      str('tapediff.forked_from.mode', fork.mode),
      str('tapediff.forked_from.source_created_at', fork.sourceCreatedAt),
    );
    if (fork.at !== null)
      attributes.push(int('tapediff.forked_from.at', fork.at));
  }
  return attributes;
}

function rootSpan(
  header: TapeHeader,
  context: TraceContext,
  inspected: readonly InspectedExchange[],
  children: readonly Span[],
): Span {
  const starts = children.map((span) => BigInt(span.startTimeUnixNano));
  const ends = children.map((span) => BigInt(span.endTimeUnixNano));
  return {
    traceId: context.traceId,
    spanId: context.rootId,
    name: header.name || header.command.join(' ') || 'tapediff',
    kind: 1,
    startTimeUnixNano: String(
      starts.length
        ? starts.reduce((a, b) => (a < b ? a : b))
        : nanos(header.createdAt),
    ),
    endTimeUnixNano: String(
      ends.length
        ? ends.reduce((a, b) => (a > b ? a : b))
        : nanos(header.createdAt),
    ),
    attributes: rootAttributes(header, inspected),
    status: { code: 0 },
  };
}

export function toOtlp(tape: Tape, options: ExportOptions = {}) {
  const records = [...tape.exchanges, ...tape.tools].sort(
    (a, b) => a.seq - b.seq,
  );
  const traceId = hash(
    tape.header.createdAt + records.map((record) => record.matchKey).join(''),
  ).slice(0, 32);
  const context = { traceId, rootId: hash(traceId + '-1root').slice(0, 16) };
  const inspected = tape.exchanges.map(inspectRecord);
  const linked = linkTools(tape.tools, inspected);
  const children = records.map((record) => {
    if ('kind' in record) return toolSpan(record, context, linked.get(record));
    if (record.provider === 'unknown') return unknownRouteSpan(record, context);
    const info = inspected.find((item) => item.exchange === record)!;
    return chatSpan(info, context, linked, options.includeContent ?? false);
  });
  const root = rootSpan(tape.header, context, inspected, children);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            str(
              'service.name',
              options.serviceName ?? tape.header.name ?? 'tapediff',
            ),
            str('telemetry.sdk.name', 'tapediff'),
            str('telemetry.sdk.language', 'nodejs'),
            str('telemetry.sdk.version', version),
          ],
        },
        scopeSpans: [
          { scope: { name: 'tapediff', version }, spans: [root, ...children] },
        ],
      },
    ],
  };
}

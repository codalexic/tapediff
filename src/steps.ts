import type { Exchange, Provider } from './tape/schema.js';
import { extractOpenAI } from './providers/openai.js';
import { extractAnthropic } from './providers/anthropic.js';
import { costUsd } from './providers/pricing.js';
import { modelOf, object, type Metadata } from './providers/usage.js';
import {
  blockOutput,
  chatOutput,
  contentText,
  list,
  string,
  type OutputStep,
} from './steps/content.js';
import {
  anthropicStream,
  chatStream,
  responsesStream,
  streamEvents,
} from './steps/streams.js';

export type Step =
  | {
      kind: 'llm_call';
      servedFrom?: { seq: number };
      seq: number;
      provider: Provider;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      latencyMs: number;
      status: number;
    }
  | OutputStep
  | { kind: 'input'; role: 'user' | 'system'; content: string }
  | {
      kind: 'tool_result';
      id: string;
      name?: string;
      content: string;
      isError?: boolean;
    }
  | { kind: 'error'; status: number; message: string };

type ToolResult = Extract<Step, { kind: 'tool_result' }>;
type InputStep = Extract<Step, { kind: 'input' }>;
type RequestStep = OutputStep | ToolResult | InputStep;

function inputSteps(role: unknown, value: unknown): InputStep[] {
  const content = contentText(value);
  return content &&
    (role === 'user' || role === 'system' || role === 'developer')
    ? [{ kind: 'input', role: role === 'user' ? 'user' : 'system', content }]
    : [];
}

function requestSteps(exchange: Exchange): RequestStep[] {
  const body = object(exchange.request.body);
  if (
    exchange.provider === 'openai' &&
    exchange.endpoint.split('?')[0]?.endsWith('/responses')
  ) {
    return [
      ...inputSteps('system', body.instructions),
      ...(typeof body.input === 'string'
        ? inputSteps('user', body.input)
        : list(body.input).flatMap((value): RequestStep[] => {
            const item = object(value);
            return item.type === 'function_call_output'
              ? [
                  {
                    kind: 'tool_result',
                    id: string(item.call_id),
                    content: contentText(item.output),
                  },
                ]
              : [...inputSteps(item.role, item.content), ...blockOutput(item)];
          })),
    ];
  }
  return [
    ...(exchange.provider === 'anthropic'
      ? inputSteps('system', body.system)
      : []),
    ...list(body.messages).flatMap((value): RequestStep[] => {
      const message = object(value);
      if (exchange.provider === 'openai')
        return message.role === 'tool'
          ? [
              {
                kind: 'tool_result',
                id: string(message.tool_call_id),
                content: contentText(message.content),
              },
            ]
          : message.role === 'assistant'
            ? chatOutput(message)
            : inputSteps(message.role, message.content);
      return [
        ...inputSteps(message.role, message.content),
        ...list(message.content).flatMap(
          (value): (OutputStep | ToolResult)[] => {
            const block = object(value);
            return block.type === 'tool_result'
              ? [
                  {
                    kind: 'tool_result',
                    id: string(block.tool_use_id),
                    content: contentText(block.content),
                    ...(typeof block.is_error === 'boolean'
                      ? { isError: block.is_error }
                      : {}),
                  },
                ]
              : blockOutput(block);
          },
        ),
      ];
    }),
  ];
}

function responseSteps(
  exchange: Exchange,
  events: Record<string, unknown>[],
): OutputStep[] {
  const body = object(exchange.response.body);
  if (exchange.provider === 'anthropic')
    return exchange.response.sse
      ? anthropicStream(events)
      : list(body.content).flatMap(blockOutput);
  if (exchange.endpoint.split('?')[0]?.endsWith('/responses'))
    return exchange.response.sse
      ? responsesStream(events)
      : list(body.output).flatMap(blockOutput);
  return exchange.response.sse
    ? chatStream(events)
    : list(body.choices).flatMap((choice) =>
        chatOutput(object(choice).message),
      );
}

function responseError(
  exchange: Exchange,
  events: Record<string, unknown>[],
): string | undefined {
  const body = object(exchange.response.body);
  const failure = events.find(
    (event) =>
      event.type === 'error' || event.error || event.type === 'response.failed',
  );
  const error = body.error ?? failure?.error ?? object(failure?.response).error;
  if (error || failure || exchange.response.status >= 400) {
    return (
      string(object(error).message) ||
      string(error) ||
      string(failure?.message) ||
      string(exchange.response.body) ||
      `HTTP ${exchange.response.status}`
    );
  }
  return undefined;
}

/** Convert a run to provider-neutral steps without mutating exchanges or their bodies. */
export function toSteps(exchanges: Exchange[]): Step[] {
  const steps: Step[] = [];
  const names = new Map<string, string>();
  const seenResults = new Set<string>();
  const seenInputs = new Set<string>();
  for (const exchange of [...exchanges].sort((a, b) => a.seq - b.seq)) {
    if (exchange.provider !== 'unknown') {
      const history = requestSteps(exchange);
      for (const step of history)
        if (step.kind === 'tool_call' && step.id) names.set(step.id, step.name);
      for (const step of history) {
        if (step.kind === 'input') {
          const key = JSON.stringify([step.role, step.content]);
          if (!seenInputs.has(key)) steps.push(step);
          seenInputs.add(key);
          continue;
        }
        if (step.kind !== 'tool_result' || seenResults.has(step.id)) continue;
        seenResults.add(step.id);
        const name = names.get(step.id);
        steps.push({ ...step, ...(name === undefined ? {} : { name }) });
      }
    }
    const events = streamEvents(exchange.response.sse ?? []);
    let metadata: Metadata = { model: modelOf(exchange.request.body) };
    const extract =
      exchange.provider === 'openai' ? extractOpenAI : extractAnthropic;
    if (exchange.provider !== 'unknown')
      for (const value of [exchange.response.body, ...events])
        metadata = extract(value, metadata);
    const model = exchange.model ?? metadata.model ?? null;
    const usage = exchange.usage ?? metadata.usage;
    steps.push({
      kind: 'llm_call',
      ...(exchange.servedFrom ? { servedFrom: exchange.servedFrom } : {}),
      seq: exchange.seq,
      provider: exchange.provider,
      model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsd:
        exchange.costUsd !== undefined
          ? exchange.costUsd
          : costUsd(model ?? undefined, usage, exchange.provider),
      latencyMs: exchange.timing.latencyMs,
      status: exchange.response.status,
    });
    if (exchange.provider === 'unknown') continue;
    const error = responseError(exchange, events);
    if (exchange.response.status < 400) {
      for (const step of responseSteps(exchange, events)) {
        if (step.kind === 'tool_call' && step.id) names.set(step.id, step.name);
        steps.push(step);
      }
    }
    if (error || exchange.aborted)
      steps.push({
        kind: 'error',
        status: exchange.response.status,
        message: error ?? 'Exchange aborted',
      });
  }
  return steps;
}

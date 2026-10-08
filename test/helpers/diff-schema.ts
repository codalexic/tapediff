import { z } from 'zod';

// This validator mirrors schema/diff.v1.json. The schema parity test prevents drift.
const number = z.number();
const count = number.int().nonnegative();
const cost = number.nonnegative().nullable();
const step = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('llm_call'),
    seq: count,
    provider: z.enum(['openai', 'anthropic', 'unknown']),
    model: z.string().nullable(),
    inputTokens: count,
    outputTokens: count,
    costUsd: cost,
    latencyMs: number.nonnegative(),
    status: number.int().min(100).max(599),
  }),
  z.strictObject({
    kind: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    args: z.json(),
  }),
  z.strictObject({
    kind: z.literal('tool_result'),
    id: z.string(),
    name: z.string().optional(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('text'), content: z.string() }),
  z.strictObject({
    kind: z.literal('input'),
    role: z.enum(['user', 'system']),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('error'),
    status: number.int().min(100).max(599),
    message: z.string(),
  }),
]);
const change = z.strictObject({
  path: z.string(),
  before: z.json().optional(),
  after: z.json().optional(),
});
const detail = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('json'), changes: z.array(change) }),
  z.strictObject({ kind: z.literal('fields'), changes: z.array(change) }),
  z.strictObject({
    kind: z.literal('text'),
    mode: z.enum(['words', 'lines']),
    changes: z.array(
      z.strictObject({
        type: z.enum(['equal', 'added', 'removed']),
        value: z.string(),
      }),
    ),
    fields: z.array(change),
  }),
]);
const pair = { aIndex: count, bIndex: count, a: step, b: step };
const op = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('equal'), ...pair }),
  z.strictObject({ type: z.literal('changed'), ...pair, detail }),
  z.strictObject({ type: z.literal('added'), bIndex: count, b: step }),
  z.strictObject({ type: z.literal('removed'), aIndex: count, a: step }),
]);
const metadata = z.strictObject({
  name: z.string().nullable(),
  path: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
const totals = z.strictObject({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  tokens: count,
  costUsd: cost,
  latencyMs: number.nonnegative(),
});
const delta = z.strictObject({
  calls: number.int(),
  inputTokens: number.int(),
  outputTokens: number.int(),
  tokens: number.int(),
  costUsd: number.nullable(),
  latencyMs: number,
});
const modelTotals = z.strictObject({
  calls: count,
  tokens: count,
  costUsd: cost,
});
export const diffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  a: metadata,
  b: metadata,
  identical: z.boolean(),
  firstDivergence: z
    .union([
      z.strictObject({ index: count, a: step, b: step.optional() }),
      z.strictObject({ index: count, b: step }),
    ])
    .nullable(),
  ops: z.array(op),
  toolCalls: z.strictObject({ added: count, removed: count, changed: count }),
  finalText: z.strictObject({
    a: z.string(),
    b: z.string(),
    changed: z.boolean(),
  }),
  totals: z.strictObject({ a: totals, b: totals, delta }),
  byModel: z.array(
    z.strictObject({
      model: z.string().nullable(),
      a: modelTotals,
      b: modelTotals,
    }),
  ),
});

export function jsonSchema() {
  return {
    ...z.toJSONSchema(diffSchema, { target: 'draft-2020-12', reused: 'ref' }),
    title: 'tapediff diff v1',
    description:
      'Behavioral comparison of two recorded runs. See docs/diff-json-schema.md for semantics.',
  };
}

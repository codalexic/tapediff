import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readTape } from '../../src/tape/io.js';
import { toSteps, type Step } from '../../src/steps.js';
import { diffRuns, finalText, type Run } from '../../src/diff/index.js';
import { renderJson } from '../../src/diff/render-json.js';
import { renderText } from '../../src/diff/render-text.js';
import { diffSchema, jsonSchema } from '../helpers/diff-schema.js';

const fixture = await readTape(
  fileURLToPath(new URL('../fixtures/steps/chat-json.tape', import.meta.url)),
);
const base: Run = {
  name: 'baseline',
  path: 'baseline.tape',
  createdAt: fixture.header.createdAt,
  steps: toSteps(fixture.exchanges),
};
const run = (steps: readonly Step[]): Run => ({
  ...base,
  name: 'candidate',
  path: 'candidate.tape',
  steps,
});
const call = base.steps.find((step) => step.kind === 'llm_call')!;
if (call.kind !== 'llm_call') throw new Error('expected fixture call');

const cases: { name: string; steps: Step[] }[] = [
  { name: 'identical', steps: structuredClone(base.steps) as Step[] },
  {
    name: 'changed-tool-args',
    steps: base.steps.map((step) =>
      step.kind === 'tool_call' && step.name === 'get_weather'
        ? { ...step, args: { city: 'Tokyo' } }
        : step,
    ),
  },
  {
    name: 'extra-tool-call',
    steps: [
      ...base.steps.slice(0, 5),
      {
        kind: 'tool_call',
        id: 'extra',
        name: 'get_calendar',
        args: { day: 'today' },
      },
      ...base.steps.slice(5),
    ],
  },
  {
    name: 'different-final-answer',
    steps: [
      ...base.steps.slice(0, -1),
      { kind: 'text', content: "It's rainy in Tokyo." },
    ],
  },
  {
    name: 'model-swapped',
    steps: base.steps.map((step) =>
      step.kind === 'llm_call'
        ? {
            ...step,
            model: 'gpt-4o',
            inputTokens: 2000,
            latencyMs: 1200,
            costUsd: 0.005,
          }
        : step,
    ),
  },
  {
    name: 'error-introduced',
    steps: [
      ...base.steps.slice(0, -2),
      { ...call, seq: 1, status: 429 },
      { kind: 'error', status: 429, message: 'Rate limit exceeded' },
    ],
  },
  {
    name: 'changed-prompt',
    steps: base.steps.map((step) =>
      step.kind === 'input' ? { ...step, content: 'Weather in Tokyo?' } : step,
    ),
  },
];

it.each(cases)(
  'snapshots $name text and JSON and validates the public schema',
  async ({ name, steps }) => {
    const result = diffRuns(base, run(steps));
    const json = renderJson(result);
    expect(diffSchema.parse(JSON.parse(json))).toEqual(result);
    await expect(renderText(result, 100, false)).toMatchFileSnapshot(
      `../fixtures/diff/${name}.txt`,
    );
    await expect(json).toMatchFileSnapshot(`../fixtures/diff/${name}.json`);
    expect(result.identical).toBe(name === 'identical');
  },
);

it('keeps the JSON Schema and minimal zod validator in sync', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../../schema/diff.v1.json', import.meta.url),
      'utf8',
    ),
  ) as unknown;
  expect(schema).toEqual(jsonSchema());
  const result = diffRuns(base, base);
  expect(diffSchema.safeParse({ ...result, schemaVersion: 2 }).success).toBe(
    false,
  );
  expect(
    diffSchema.safeParse({ ...result, ops: [{ type: 'added' }] }).success,
  ).toBe(false);
  expect(
    diffSchema.safeParse({
      ...result,
      totals: { ...result.totals, a: { ...result.totals.a, tokens: -1 } },
    }).success,
  ).toBe(false);
});

it('ignores usage, cost, latency, sequence and generated IDs for behavior, retaining totals', () => {
  const before = structuredClone(base);
  const b = run(
    base.steps.map((step) => {
      if (step.kind === 'llm_call')
        return {
          ...step,
          seq: step.seq + 10,
          inputTokens: 2408,
          latencyMs: 65_000,
          costUsd: null,
        };
      if (step.kind === 'tool_call' || step.kind === 'tool_result')
        return { ...step, id: `new-${step.id}` };
      return step;
    }),
  );
  const result = diffRuns(base, b);
  expect(result.identical).toBe(true);
  expect(result.firstDivergence).toBeNull();
  expect(result.totals.delta).toEqual({
    calls: 0,
    inputTokens: 2408,
    outputTokens: 0,
    tokens: 2408,
    costUsd: null,
    latencyMs: 128_360,
  });
  expect(result.byModel).toEqual([
    {
      model: 'gpt-4.1',
      a: { calls: 2, tokens: 2584, costUsd: 0.006224 },
      b: { calls: 2, tokens: 4992, costUsd: null },
    },
  ]);
  expect(base).toEqual(before);
});

it('reports the first aligned divergence, call counts, and signed totals', () => {
  const result = diffRuns(base, run(cases[1]!.steps));
  expect(result.firstDivergence).toEqual({
    index: 3,
    a: base.steps[3],
    b: cases[1]!.steps[3],
  });
  expect(result.toolCalls).toEqual({ added: 0, removed: 0, changed: 1 });
  expect(diffRuns(base, run(cases[2]!.steps)).toolCalls.added).toBe(1);
  expect(diffRuns(run(cases[2]!.steps), base).toolCalls.removed).toBe(1);
  const empty = run([]);
  const removed = diffRuns(base, empty);
  expect(removed.totals.delta.calls).toBe(-2);
  expect(removed.totals.delta.tokens).toBe(-2584);
  expect(removed.firstDivergence).toEqual({ index: 0, a: base.steps[0] });
  expect(diffRuns(empty, base).firstDivergence).toEqual({
    index: 0,
    b: base.steps[0],
  });
  const identical = diffRuns(empty, empty);
  expect(identical).toMatchObject({
    identical: true,
    firstDivergence: null,
    ops: [],
    byModel: [],
    finalText: { a: '', b: '', changed: false },
  });
  expect(diffSchema.safeParse(removed).success).toBe(true);
  expect(diffSchema.safeParse(identical).success).toBe(true);
});

it('reports model substitutions and same-model status changes', () => {
  const swapped = diffRuns(run([call]), run([{ ...call, model: 'other' }]));
  expect(swapped.ops.map((op) => op.type)).toEqual(['removed', 'added']);
  expect(swapped.byModel.map((row) => row.model)).toEqual(['gpt-4.1', 'other']);
  expect(
    diffRuns(run([call]), run([{ ...call, status: 500 }])).ops,
  ).toMatchObject([
    {
      type: 'changed',
      detail: {
        kind: 'fields',
        changes: [{ path: '/status', before: 200, after: 500 }],
      },
    },
  ]);
});

it('selects only the last response text, including multiple blocks or partial output', () => {
  expect(finalText([...base.steps, call])).toBe('');
  expect(
    finalText([
      call,
      { kind: 'text', content: 'a' },
      { kind: 'text', content: 'b' },
    ]),
  ).toBe('ab');
  expect(
    finalText([
      call,
      { kind: 'text', content: 'partial' },
      { kind: 'error', status: 200, message: 'aborted' },
    ]),
  ).toBe('partial');
});

it('sorts JSON keys recursively without changing array order or its input', () => {
  const step: Step = {
    kind: 'tool_call',
    id: 'x',
    name: 'f',
    args: { z: 1, a: { y: 1, b: 2 } },
  };
  const reordered: Step = { ...step, args: { a: { b: 2, y: 1 }, z: 1 } };
  expect(renderJson(diffRuns(run([step]), run([step])))).toBe(
    renderJson(diffRuns(run([reordered]), run([reordered]))),
  );
});

it('collapses long equal runs, displays deltas and bounds sanitized terminal output', () => {
  const result = diffRuns(base, run(cases[1]!.steps));
  const output = renderText(result, 100, false);
  expect(output).toContain('… 4 identical steps …');
  expect(output).toContain('city: "Paris" → "Tokyo"');
  expect(output).toContain('first divergence at step 4');
  expect(output).toContain('(no change)');
  expect(output).not.toContain('\x1b');
  expect(renderText(result, 100, true)).toContain('\x1b');
  const unsafe = diffRuns(
    { ...base, name: '\x1b[31mBAD\nname' },
    run([{ kind: 'text', content: '\x1b[2J' }]),
  );
  expect(renderText(unsafe, 100, false)).toContain('\\u001b[31mBAD\\u000aname');
  expect(renderText(unsafe, 100, false)).not.toContain('\x1b');
  for (const width of [1, 30, 80])
    expect(
      renderText(unsafe, width, false)
        .split('\n')
        .every((line) => Array.from(line).length <= width),
    ).toBe(true);
  expect(renderText(diffRuns(run([]), run([call])), 100, false)).toContain(
    '(+1)',
  );
  expect(
    renderText(
      diffRuns(run([call]), run([{ ...call, inputTokens: 1579 }])),
      100,
      false,
    ),
  ).toContain('(+375; +29%)');
  expect(
    renderText(
      diffRuns(run([call]), run([{ ...call, costUsd: null }])),
      100,
      false,
    ),
  ).toContain('(delta unknown)');
});

it('renders line changes and unknown models', () => {
  const result = diffRuns(
    run([
      { ...call, model: null },
      { kind: 'text', content: 'a\nb\n' },
    ]),
    run([
      { ...call, model: null },
      { kind: 'text', content: 'a\nc\n' },
    ]),
  );
  expect(renderText(result, 100, false)).toContain('- b\n+ c\n');
  expect(result.byModel[0]?.model).toBeNull();
});

it('shows changed prompts as the root cause and renders final text only once', () => {
  const input: Step = {
    kind: 'input',
    role: 'user',
    content: 'Weather in Paris?',
  };
  const result = diffRuns(
    run([input, call, { kind: 'text', content: 'sunny' }]),
    run([
      { ...input, content: 'Weather in Tokyo?' },
      call,
      { kind: 'text', content: 'rainy' },
    ]),
  );
  expect(result.firstDivergence?.index).toBe(0);
  expect(result.ops[0]).toMatchObject({
    type: 'changed',
    detail: { kind: 'text' },
  });
  const text = renderText(result);
  expect(text).toContain('~ input user\n  Weather in [-Paris-]{+Tokyo+}?');
  expect(text.match(/sunny/g)).toHaveLength(1);
  expect(text.match(/rainy/g)).toHaveLength(1);
  expect(result.ops.at(-1)).toMatchObject({
    type: 'changed',
    a: { kind: 'text' },
  });
  expect(
    diffRuns(run([input]), run([{ ...input, role: 'system' }])).ops.map(
      (op) => op.type,
    ),
  ).toEqual(['removed', 'added']);
});

it('keeps non-zero cost deltas visible and omits percentages for a zero baseline', () => {
  const output = (a: number, b: number) =>
    renderText(
      diffRuns(run([{ ...call, costUsd: a }]), run([{ ...call, costUsd: b }])),
    );
  expect(output(0, 0.00004)).toContain('(+$0.00004)');
  expect(output(0.00004, 0)).toContain('(-$0.00004; -100%)');
  expect(output(0, 0)).toContain('(no change)');
  expect(output(0, 1e-22)).toContain('(+$1.00e-22)');
});

it.each(['chat', 'responses', 'anthropic'])(
  'compares %s JSON and streamed fixture behavior identically',
  async (api) => {
    const load = async (mode: string) => {
      const tape = await readTape(
        fileURLToPath(
          new URL(`../fixtures/steps/${api}-${mode}.tape`, import.meta.url),
        ),
      );
      return run(toSteps(tape.exchanges));
    };
    const [json, stream, error] = await Promise.all([
      load('json'),
      load('stream'),
      load('error'),
    ]);
    expect(diffRuns(json, stream).identical).toBe(true);
    const failed = diffRuns(json, error);
    expect(failed.identical).toBe(false);
    expect(diffSchema.safeParse(failed).success).toBe(true);
  },
);

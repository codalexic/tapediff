import { expect, it } from 'vitest';
import { displayContent } from '../../src/content-display.js';
import { money, moneyDelta } from '../../src/format.js';
import { renderSteps } from '../../src/commands/show.js';
import { diffRuns, type Run } from '../../src/diff/index.js';
import { renderJson } from '../../src/diff/render-json.js';
import { renderText, summary } from '../../src/diff/render-text.js';
import { fullStep, wordChanges } from '../../src/tui/detail.js';
import type { Step } from '../../src/steps.js';

const run = (step: Step): Run => ({
  name: null,
  path: 'test.tape',
  createdAt: '2026-10-09T00:00:00Z',
  steps: [step],
});

it.each([
  [
    ' { "city": "Paris", "temperature_c": 22 } ',
    '{"city":"Paris","temperature_c":22}',
  ],
  ['[1, {"a": 2}]', '[1,{"a":2}]'],
  ['null', '"null"'],
  ['22', '"22"'],
  ['true', '"true"'],
  ['"hello"', '"\\"hello\\""'],
  ['{broken', '"{broken"'],
])('renders container content without double escaping: %s', (input, output) => {
  expect(displayContent(input)).toBe(output);
});

it.each(['tool_result', 'text'] as const)(
  'shares compact %s rendering and structural changes without mutating JSON',
  (kind) => {
    const a: Extract<Step, { kind: 'text' | 'tool_result' }> = {
      kind,
      id: 'a',
      content: '{ "city": "Paris", "items": [1, 2] }',
    };
    const b: Step = { ...a, content: '{ "items": [1, 3], "city": "Tokyo" }' };
    const result = diffRuns(run(a), run(b));
    const before = renderJson(result);
    expect(renderSteps([a])).toContain('{"city":"Paris","items":[1,2]}');
    expect(summary(a)).toContain('{"city":"Paris","items":[1,2]}');
    expect(fullStep(a)).toContain('{"city":"Paris","items":[1,2]}');
    const text = renderText(result, 120, false);
    expect(text).toContain('city: "Paris" → "Tokyo"');
    expect(text).toContain('/items/1: 2 → 3');
    expect(text).not.toContain('\\"city\\"');
    expect(wordChanges(result.ops[0]!)).toContain('/items/1: 2 → 3');
    expect(renderJson(result)).toBe(before);
    expect(result.ops[0]).toMatchObject({
      type: 'changed',
      a: { content: a.content },
      detail: { kind: 'text' },
    });
  },
);

it('retains result errors and reports formatting-only changes honestly', () => {
  const a: Step = { kind: 'tool_result', id: 'x', content: '{"a":1,"b":2}' };
  const b: Step = { ...a, content: '{ "b":2, "a":1 }' };
  const result = diffRuns(run(a), run(b));
  expect(renderText(result)).toContain(
    'JSON values unchanged (formatting differs)',
  );
  expect(wordChanges(result.ops[0]!)).toContain('JSON values unchanged');
  expect(renderText(diffRuns(run(a), run({ ...b, isError: true })))).toContain(
    'isError: false → true',
  );
});

it('handles arrays, container-to-text changes, and terminal controls', () => {
  const a: Step = { kind: 'text', content: '[{"name":"old"}]' };
  expect(
    renderText(diffRuns(run(a), run({ ...a, content: '[{"name":"new"}]' }))),
  ).toContain('/0/name: "old" → "new"');
  expect(
    renderText(diffRuns(run(a), run({ ...a, content: 'plain' }))),
  ).toContain('(root): [{"name":"old"}] → "plain"');
  expect(
    renderSteps([{ ...a, content: '{"unsafe":"\\u001b[31m"}' }]),
  ).not.toContain('\x1b');
});

it.each([
  [null, 'cost unknown'],
  [0, '$0'],
  [-0, '$0'],
  [0.00003, '$0.00003'],
  [-0.00003, '-$0.00003'],
  [0.003112, '$0.0031'],
  [1e-25, '$1.00e-25'],
] as const)('formats cost %s as %s everywhere', (value, expected) => {
  expect(money(value)).toBe(expected);
  if (value !== null) expect(moneyDelta(value)).toBe(expected);
  const call: Step = {
    kind: 'llm_call',
    seq: 0,
    provider: 'openai',
    model: 'test',
    status: 200,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: value,
    latencyMs: 1,
  };
  expect(renderSteps([call])).toContain(`2 tokens · ${expected}`);
  expect(renderText(diffRuns(run(call), run(call)))).toContain(
    `${expected} → ${expected}`,
  );
});

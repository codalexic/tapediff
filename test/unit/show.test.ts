import { expect, it } from 'vitest';
import { renderSteps, stepTotals } from '../../src/commands/show.js';
import type { Step } from '../../src/steps.js';
import { terminalLine } from '../../src/terminal.js';
import type { ToolRecord } from '../../src/tape/schema.js';

const call: Step = {
  kind: 'llm_call',
  seq: 0,
  provider: 'openai',
  model: 'gpt-4.1',
  inputTokens: 1204,
  outputTokens: 88,
  costUsd: 0.003112,
  latencyMs: 820,
  status: 200,
};

it.each([1, 2])(
  'counts %i other requests separately from LLM totals',
  (others) => {
    const steps: Step[] = [
      call,
      ...Array.from({ length: others }, () => ({
        ...call,
        provider: 'unknown' as const,
        inputTokens: 9999,
        costUsd: 99,
      })),
      { ...call, seq: 3 },
    ];
    const text = renderSteps(steps, 200);
    expect(text).toMatchSnapshot();
    expect(text).toContain('#2  gpt-4.1');
    expect(text).not.toContain('#3');
    expect(text).toContain(
      `total: 2 calls · 2.6k tokens · $0.0062 · 1.6s (+${others} other request${others === 1 ? '' : 's'})`,
    );
    expect(stepTotals(steps).calls).toBe(2 + others);
  },
);

it('places tools after the first matching preceding call, with canonical args and sequence fallback', () => {
  const toolCall = (
    id: string,
    args: ToolRecord['args'],
    name = 'weather',
  ): Step => ({
    kind: 'tool_call',
    id,
    name,
    args,
  });
  const record = (
    seq: number,
    args: ToolRecord['args'],
    result: string,
    name = 'weather',
  ): ToolRecord => ({
    kind: 'tool',
    id: seq,
    seq,
    name,
    args,
    result,
    matchKey: 'a'.repeat(64),
    timing: { startedAt: '2026-10-09T00:00:00Z', latencyMs: 3 },
  });
  const steps: Step[] = [
    call,
    toolCall('first', { a: 1, b: 2 }),
    toolCall('second', { b: 2, a: 1 }),
    { kind: 'tool_result', id: 'first', name: 'weather', content: 'result' },
    { ...call, seq: 5 },
    toolCall('future', { city: 'future' }),
  ];
  const records = [
    record(6, { city: 'future' }, 'future match'),
    record(1, { b: 2, a: 1 }, 'first match'),
    record(2, { a: 1, b: 2 }, 'second match'),
    record(3, { city: 'future' }, 'no preceding match'),
    record(4, { a: 1, b: 2 }, 'different name', 'other'),
    record(7, { city: 'different' }, 'different args'),
  ];
  expect(renderSteps(steps, 200, false, records)).toMatchInlineSnapshot(`
    "#1  gpt-4.1  1,204→88 tok  $0.0031  820ms
        → tool_call weather {"a":1,"b":2}
        ⚙ weather {"b":2,"a":1} → "\\"first match\\"" 3ms
        → tool_call weather {"b":2,"a":1}
        ⚙ weather {"a":1,"b":2} → "\\"second match\\"" 3ms
        ← tool_result weather "result"
        ⚙ weather {"city":"future"} → "\\"no preceding match\\"" 3ms
        ⚙ other {"a":1,"b":2} → "\\"different name\\"" 3ms
    #2  gpt-4.1  1,204→88 tok  $0.0031  820ms
        → tool_call weather {"city":"future"}
        ⚙ weather {"city":"future"} → "\\"future match\\"" 3ms
        ⚙ weather {"city":"different"} → "\\"different args\\"" 3ms
    total: 2 calls · 2.6k tokens · $0.0062 · 1.6s
    "
  `);
});

it('counts wide characters and preserves combining sequences when truncating', () => {
  expect(terminalLine('晴天晴天', 5)).toBe('晴天…');
  expect(terminalLine('🌤️🌤️🌤️', 5)).toBe('🌤️🌤️…');
  expect(terminalLine('e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…');
});

it('renders a readable timeline and accurate totals', () => {
  const steps: Step[] = [
    call,
    {
      kind: 'tool_call',
      id: 'a',
      name: 'get_weather',
      args: { city: 'Paris' },
    },
    {
      kind: 'tool_result',
      id: 'a',
      name: 'get_weather',
      content: '18°C, sunny',
    },
    { ...call, seq: 1 },
    { kind: 'text', content: "It's sunny." },
  ];
  const text = renderSteps(steps);
  expect(text).toContain('#1  gpt-4.1  1,204→88 tok  $0.0031  820ms');
  expect(text).toContain('→ tool_call get_weather {"city":"Paris"}');
  expect(text).toContain('← tool_result get_weather "18°C, sunny"');
  expect(text).toContain('✓ final: "It\'s sunny."');
  expect(text).toContain('total: 2 calls · 2.6k tokens · $0.0062 · 1.6s');
  expect(stepTotals(steps)).toEqual({
    calls: 2,
    inputTokens: 2408,
    outputTokens: 176,
    tokens: 2584,
    costUsd: 0.006224,
    latencyMs: 1640,
  });
});

it('shows and truncates input roles and content', () => {
  expect(
    renderSteps([{ kind: 'input', role: 'user', content: 'Weather?' }]),
  ).toContain('» user: "Weather?"');
  expect(
    renderSteps(
      [{ kind: 'input', role: 'system', content: 'x'.repeat(200) }],
      30,
    ),
  ).toContain('» system:');
  expect(
    renderSteps(
      [{ kind: 'input', role: 'system', content: 'x'.repeat(200) }],
      30,
    ).split('\n')[0]?.length,
  ).toBe(30);
});

it('truncates long arguments and content, including the final answer, to the specified width', () => {
  const steps: Step[] = [
    call,
    { kind: 'tool_call', id: 'a', name: 'long', args: 'x'.repeat(200) },
    { kind: 'tool_result', id: 'a', content: 'y'.repeat(200) },
    call,
    { kind: 'text', content: 'z'.repeat(200) },
  ];
  for (const width of [1, 30, 100]) {
    const lines = renderSteps(steps, width).trimEnd().split('\n');
    expect(lines.every((line) => Array.from(line).length <= width)).toBe(true);
    expect(lines.some((line) => line.endsWith('…'))).toBe(true);
  }
});

it('does not label an older answer or aborted output as the final answer; handles empty runs and unknown cost', () => {
  expect(
    renderSteps([call, { kind: 'text', content: 'old' }, call]),
  ).not.toContain('✓ final');
  expect(
    renderSteps([
      call,
      { kind: 'text', content: 'partial' },
      { kind: 'error', status: 200, message: 'aborted' },
    ]),
  ).not.toContain('✓ final');
  expect(renderSteps([])).toBe('total: 0 calls · 0 tokens · $0 · 0ms\n');
  expect(stepTotals([call, { ...call, costUsd: null }]).costUsd).toBeNull();
  expect(renderSteps([{ ...call, costUsd: null }])).toContain('cost unknown');
});

it('escapes recorded terminal controls and uses picocolors only when enabled', () => {
  const steps: Step[] = [{ ...call, model: '\x1b[31mBAD\nmodel' }];
  expect(renderSteps(steps)).toContain('\\u001b[31mBAD\\u000amodel');
  expect(renderSteps(steps)).not.toContain('\x1b');
  expect(renderSteps(steps, 100, true)).toContain('\x1b');
});

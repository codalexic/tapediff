import { expect, it } from 'vitest';
import { renderSteps, stepTotals } from '../../src/commands/show.js';
import type { Step } from '../../src/steps.js';
import { terminalLine } from '../../src/terminal.js';

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

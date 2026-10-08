import { expect, it } from 'vitest';
import { latency, useColor } from '../../src/format.js';
import { renderSteps } from '../../src/commands/show.js';

it.each([
  [0, '0ms'],
  [32, '32ms'],
  [999, '999ms'],
  [1000, '1.0s'],
  [2400, '2.4s'],
  [60_000, '1m 00s'],
  [65_000, '1m 05s'],
  [119_999, '2m 00s'],
  [-65_000, '-1m 05s'],
] as const)('formats %dms as %s', (ms, result) => {
  expect(latency(ms)).toBe(result);
});

it('show uses the shared formatter for short total latency', () => {
  expect(
    renderSteps([
      {
        kind: 'llm_call',
        seq: 0,
        provider: 'openai',
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        latencyMs: 32,
        status: 200,
      },
    ]),
  ).toContain('cost unknown · 32ms');
});

it('supports FORCE_COLOR while respecting NO_COLOR and explicit disable', () => {
  expect(useColor(true, true, {})).toBe(true);
  expect(useColor(true, false, {})).toBe(false);
  expect(useColor(true, false, { FORCE_COLOR: '0' })).toBe(false);
  expect(useColor(true, false, { FORCE_COLOR: '1', NO_COLOR: '' })).toBe(false);
  expect(useColor(true, true, { NO_COLOR: '' })).toBe(false);
  expect(useColor(true, false, { FORCE_COLOR: '1' })).toBe(true);
  expect(useColor(false, true, { FORCE_COLOR: '1' })).toBe(false);
});

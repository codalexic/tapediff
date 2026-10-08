import type { Step } from './steps.js';

export interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number | null;
  latencyMs: number;
}

/** Shared input + output accounting; provider cache counts are not added again. */
export function addCallTotals(
  totals: Totals,
  call: Extract<Step, { kind: 'llm_call' }>,
): Totals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + call.inputTokens,
    outputTokens: totals.outputTokens + call.outputTokens,
    tokens: totals.tokens + call.inputTokens + call.outputTokens,
    costUsd:
      totals.costUsd === null || call.costUsd === null
        ? null
        : totals.costUsd + call.costUsd,
    latencyMs: totals.latencyMs + call.latencyMs,
  };
}

export function stepTotals(steps: readonly Step[]): Totals {
  let totals: Totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  for (const step of steps) {
    if (step.kind !== 'llm_call') continue;
    totals = addCallTotals(totals, step);
  }
  return totals;
}

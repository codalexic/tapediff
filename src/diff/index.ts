import type { Step } from '../steps.js';
import { stepTotals, type Totals } from '../totals.js';
import { align } from './align.js';

export interface Run {
  name: string | null;
  path: string;
  createdAt: string;
  steps: readonly Step[];
}

/** Text from the last response only; an empty/error response never revives older text. */
export function finalText(steps: readonly Step[]): string {
  const lastCall = steps.map((step) => step.kind).lastIndexOf('llm_call');
  return steps
    .slice(lastCall + 1)
    .filter((step) => step.kind === 'text')
    .map((step) => step.content)
    .join('');
}

function delta(a: Totals, b: Totals): Totals {
  return {
    calls: b.calls - a.calls,
    inputTokens: b.inputTokens - a.inputTokens,
    outputTokens: b.outputTokens - a.outputTokens,
    tokens: b.tokens - a.tokens,
    costUsd:
      a.costUsd === null || b.costUsd === null ? null : b.costUsd - a.costUsd,
    latencyMs: b.latencyMs - a.latencyMs,
  };
}

export function diffRuns(a: Run, b: Run) {
  const ops = align(a.steps, b.steps);
  const index = ops.findIndex((op) => op.type !== 'equal');
  const first = ops[index];
  const totalsA = stepTotals(a.steps);
  const totalsB = stepTotals(b.steps);
  const textA = finalText(a.steps);
  const textB = finalText(b.steps);
  const models = [
    ...new Set(
      [...a.steps, ...b.steps].flatMap((step) =>
        step.kind === 'llm_call' ? [step.model] : [],
      ),
    ),
  ].sort((x, y) =>
    x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1,
  );
  const modelTotals = (run: Run, model: string | null) => {
    const total = stepTotals(
      run.steps.filter(
        (step) => step.kind === 'llm_call' && step.model === model,
      ),
    );
    return { calls: total.calls, tokens: total.tokens, costUsd: total.costUsd };
  };
  const metadata = (run: Run) => ({
    name: run.name,
    path: run.path,
    createdAt: run.createdAt,
  });
  return {
    schemaVersion: 1 as const,
    a: metadata(a),
    b: metadata(b),
    identical: index === -1,
    firstDivergence: first
      ? {
          index,
          ...('a' in first ? { a: first.a } : {}),
          ...('b' in first ? { b: first.b } : {}),
        }
      : null,
    ops,
    toolCalls: {
      added: ops.filter(
        (op) => op.type === 'added' && op.b.kind === 'tool_call',
      ).length,
      removed: ops.filter(
        (op) => op.type === 'removed' && op.a.kind === 'tool_call',
      ).length,
      changed: ops.filter(
        (op) => op.type === 'changed' && op.a.kind === 'tool_call',
      ).length,
    },
    finalText: { a: textA, b: textB, changed: textA !== textB },
    totals: { a: totalsA, b: totalsB, delta: delta(totalsA, totalsB) },
    byModel: models.map((model) => ({
      model,
      a: modelTotals(a, model),
      b: modelTotals(b, model),
    })),
  };
}

export type RunDiff = ReturnType<typeof diffRuns>;

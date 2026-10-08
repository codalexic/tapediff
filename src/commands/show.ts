import { readTapeOrFail } from '../tape/read-or-fail.js';
import { toSteps, type Step } from '../steps.js';
import {
  count,
  money,
  tokens,
  latency,
  textFormatter,
  useColor,
} from '../format.js';
import { stepTotals } from '../totals.js';
import { displayContent } from '../content-display.js';

export { stepTotals, type Totals } from '../totals.js';

export function renderSteps(
  steps: Step[],
  columns = 100,
  color = false,
): string {
  const format = textFormatter(columns, color);
  const { colors } = format;
  const lines: string[] = [];
  const line = (text: string, paint = colors.white) =>
    lines.push(format.line(text, paint));
  let callNumber = 0;
  const lastCall = steps.map((step) => step.kind).lastIndexOf('llm_call');
  const finalSteps = steps.slice(lastCall + 1);
  const finalText = finalSteps
    .filter((step) => step.kind === 'text')
    .map((step) => step.content)
    .join('');
  const hasFinal =
    lastCall >= 0 &&
    finalText !== '' &&
    !finalSteps.some(
      (step) => step.kind === 'error' || step.kind === 'tool_call',
    );
  for (const [index, step] of steps.entries()) {
    switch (step.kind) {
      case 'llm_call':
        callNumber++;
        line(
          `#${callNumber}  ${step.model ?? step.provider}  ${count(step.inputTokens)}→${count(step.outputTokens)} tok  ${money(step.costUsd)}  ${latency(step.latencyMs)}${step.status >= 400 ? `  HTTP ${step.status}` : ''}`,
          colors.bold,
        );
        break;
      case 'tool_call':
        line(
          `    → tool_call ${step.name} ${JSON.stringify(step.args)}`,
          colors.cyan,
        );
        break;
      case 'tool_result':
        line(
          `    ← tool_result ${step.name ?? step.id} ${displayContent(step.content)}${step.isError ? ' (error)' : ''}`,
          step.isError ? colors.red : colors.cyan,
        );
        break;
      case 'input':
        line(`» ${step.role}: ${JSON.stringify(step.content)}`, colors.cyan);
        break;
      case 'text':
        if (!(hasFinal && index > lastCall))
          line(`    ${displayContent(step.content)}`);
        break;
      case 'error':
        line(`    ✗ error ${step.status}: ${step.message}`, colors.red);
        break;
    }
  }
  if (hasFinal) line(`✓ final: ${displayContent(finalText)}`, colors.green);
  const totals = stepTotals(steps);
  line(
    `total: ${totals.calls} calls · ${tokens(totals.tokens)} tokens · ${money(totals.costUsd)} · ${latency(totals.latencyMs)}`,
    colors.dim,
  );
  return `${lines.join('\n')}\n`;
}

export async function showCommand(
  tape: string,
  options: { json?: boolean },
): Promise<void> {
  const data = await readTapeOrFail(tape);
  const steps = toSteps(data.exchanges);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ schemaVersion: 1, header: data.header, steps, totals: stepTotals(steps) })}\n`
      : renderSteps(steps, process.stdout.columns ?? 100, useColor()),
  );
}

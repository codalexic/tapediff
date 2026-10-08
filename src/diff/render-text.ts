import type { Step } from '../steps.js';
import {
  count,
  latency,
  money,
  moneyDelta,
  textFormatter,
  tokens,
  useColor,
} from '../format.js';
import { diffText, type JsonChange } from './detail.js';
import type { RunDiff } from './index.js';
import { textWindow } from './text-window.js';
import { displayContent } from '../content-display.js';
import { contentChanges, displayChanges } from './content-display.js';

export function summary(step: Step): string {
  switch (step.kind) {
    case 'llm_call':
      return `llm_call ${step.model ?? 'unknown model'} · HTTP ${step.status}`;
    case 'tool_call':
      return `tool_call ${step.name} ${JSON.stringify(step.args)}`;
    case 'tool_result':
      return `tool_result ${step.name ?? '(unnamed)'} ${displayContent(step.content)}${step.isError ? ' (error)' : ''}`;
    case 'input':
      return `input ${step.role} ${JSON.stringify(step.content)}`;
    case 'text':
      return `text ${displayContent(step.content)}`;
    case 'error':
      return `error ${step.status}: ${step.message}`;
  }
}

export function field(change: JsonChange, width: number): string {
  const label = /^\/[A-Za-z_]\w*$/.test(change.path)
    ? change.path.slice(1)
    : change.path || '(root)';
  if (
    typeof change.before === 'string' &&
    typeof change.after === 'string' &&
    Math.max(change.before.length, change.after.length) >
      width - label.length - 2
  )
    return `${label}: ${textWindow(change.before, change.after, width - label.length - 2)}`;
  return `${label}: ${change.before === undefined ? '(missing)' : JSON.stringify(change.before)} → ${change.after === undefined ? '(missing)' : JSON.stringify(change.after)}`;
}

function changeLabel(
  a: number | null,
  b: number | null,
  format: (n: number) => string,
): string {
  if (a === null || b === null) return 'delta unknown';
  const delta = b - a;
  if (delta === 0) return 'no change';
  const amount = `${delta > 0 ? '+' : ''}${(format === money ? moneyDelta : format)(delta)}`;
  return a > 0
    ? `${amount}; ${delta > 0 ? '+' : ''}${Math.round((delta / a) * 100)}%`
    : amount;
}

export function renderText(
  diff: RunDiff,
  columns = 100,
  color = useColor(),
): string {
  const format = textFormatter(columns, color);
  const { colors } = format;
  const lines: string[] = [];
  const line = (value: string, paint = colors.white) =>
    lines.push(format.line(value, paint));
  const jsonChanges = (changes: JsonChange[]) => {
    if (!changes.length)
      line('    JSON values unchanged (formatting differs)', colors.dim);
    for (const change of changes)
      line(`    ${field(change, columns - 4)}`, colors.yellow);
  };
  const textChanges = (a: string, b: string, words = false) => {
    const detail = diffText(a, b);
    if (
      words ||
      detail.mode === 'words' ||
      Math.max(a.length, b.length) > columns - 2
    ) {
      line(`  ${textWindow(a, b, columns - 2)}`, colors.yellow);
    } else {
      for (const part of detail.changes) {
        const rows = part.value.split('\n');
        if (rows.at(-1) === '') rows.pop();
        for (const row of rows)
          line(
            `${part.type === 'added' ? '+' : part.type === 'removed' ? '-' : ' '} ${row}`,
            part.type === 'added'
              ? colors.green
              : part.type === 'removed'
                ? colors.red
                : colors.dim,
          );
      }
    }
  };
  line(
    `tapediff · ${diff.a.name ?? diff.a.path} → ${diff.b.name ?? diff.b.path}`,
    colors.bold,
  );
  if (diff.firstDivergence)
    line(
      `first divergence at step ${diff.firstDivergence.index + 1}`,
      colors.yellow,
    );
  line('');
  // Hide only sides represented by finalText; retain a non-final counterpart.
  const lastA = Math.max(
    -1,
    ...diff.ops.flatMap((op) =>
      'a' in op && op.a.kind === 'llm_call' ? [op.aIndex] : [],
    ),
  );
  const lastB = Math.max(
    -1,
    ...diff.ops.flatMap((op) =>
      'b' in op && op.b.kind === 'llm_call' ? [op.bIndex] : [],
    ),
  );
  const ops = diff.ops.flatMap((op): typeof diff.ops => {
    const hideA = 'a' in op && op.a.kind === 'text' && op.aIndex > lastA;
    const hideB = 'b' in op && op.b.kind === 'text' && op.bIndex > lastB;
    if (hideA && 'b' in op && !hideB)
      return [{ type: 'added', b: op.b, bIndex: op.bIndex }];
    if (hideB && 'a' in op && !hideA)
      return [{ type: 'removed', a: op.a, aIndex: op.aIndex }];
    return hideA || hideB ? [] : [op];
  });
  for (let i = 0; i < ops.length;) {
    const op = ops[i]!;
    if (op.type === 'equal') {
      let end = i + 1;
      while (ops[end]?.type === 'equal') end++;
      if (end - i > 3) line(`  … ${end - i} identical steps …`, colors.dim);
      else
        for (const equal of ops.slice(i, end)) {
          if (equal.type === 'equal') line(`  ${summary(equal.a)}`, colors.dim);
        }
      i = end;
      continue;
    }
    if (op.type === 'added') line(`+ ${summary(op.b)}`, colors.green);
    else if (op.type === 'removed') line(`- ${summary(op.a)}`, colors.red);
    else if (op.a.kind === 'input' && op.b.kind === 'input') {
      line(`~ input ${op.a.role}`, colors.yellow);
      textChanges(op.a.content, op.b.content, true);
    } else {
      line(
        `~ ${op.a.kind}${op.a.kind === 'tool_call' || op.a.kind === 'tool_result' ? ` ${op.a.name ?? '(unnamed)'}` : ''}`,
        colors.yellow,
      );
      const structural = displayChanges(op);
      if (structural !== undefined) jsonChanges(structural);
      else if (op.detail.kind === 'text') {
        if (
          'content' in op.a &&
          'content' in op.b &&
          op.a.content !== op.b.content
        )
          textChanges(op.a.content, op.b.content);
        for (const change of op.detail.fields)
          line(`    ${field(change, columns - 4)}`, colors.yellow);
      } else
        for (const change of op.detail.changes)
          line(`    ${field(change, columns - 4)}`, colors.yellow);
    }
    i++;
  }
  line('');
  line(
    diff.toolCalls.added + diff.toolCalls.removed + diff.toolCalls.changed === 0
      ? 'tool calls: no change'
      : [
          diff.toolCalls.added ? `+${diff.toolCalls.added} added` : '',
          diff.toolCalls.removed ? `-${diff.toolCalls.removed} removed` : '',
          diff.toolCalls.changed ? `${diff.toolCalls.changed} changed` : '',
        ]
          .filter(Boolean)
          .join(' · ') +
          ` tool call${diff.toolCalls.added + diff.toolCalls.removed + diff.toolCalls.changed === 1 ? '' : 's'}`,
  );
  if (diff.finalText.changed) {
    line('final answer', colors.bold);
    const structural = contentChanges(diff.finalText.a, diff.finalText.b);
    if (structural !== undefined) jsonChanges(structural);
    else textChanges(diff.finalText.a, diff.finalText.b);
  } else
    line(
      `final answer: ${diff.finalText.a ? displayContent(diff.finalText.a) : '(none)'} · unchanged`,
      colors.dim,
    );
  line('');
  const { a, b } = diff.totals;
  const total = (
    label: string,
    left: number | null,
    right: number | null,
    display: (n: number) => string,
  ) =>
    line(
      `${label.padEnd(7)} ${left === null ? 'cost unknown' : display(left)} → ${right === null ? 'cost unknown' : display(right)} (${changeLabel(left, right, display)})`,
    );
  total('calls', a.calls, b.calls, count);
  total('tokens', a.tokens, b.tokens, tokens);
  total('cost', a.costUsd, b.costUsd, money);
  total('latency', a.latencyMs, b.latencyMs, latency);
  if (diff.byModel.length) {
    line('by model', colors.bold);
    for (const model of diff.byModel)
      line(
        `  ${model.model ?? '(unknown)'} · calls ${model.a.calls} → ${model.b.calls} · tokens ${tokens(model.a.tokens)} → ${tokens(model.b.tokens)} · ${money(model.a.costUsd)} → ${money(model.b.costUsd)}`,
      );
  }
  line('');
  line(
    diff.identical ? '✓ identical behavior' : '✗ behavior differs',
    diff.identical ? colors.green : colors.red,
  );
  return `${lines.join('\n')}\n`;
}

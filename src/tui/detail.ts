import type { Step } from '../steps.js';
import type { Op } from '../diff/align.js';
import { diffText } from '../diff/detail.js';
import { diffWordsWithSpace } from 'diff';
import { terminalLine } from '../terminal.js';
import { displayContent } from '../content-display.js';
import { displayChanges } from '../diff/content-display.js';
import { field } from '../diff/render-text.js';

export function fullStep(step: Step | undefined): string {
  if (!step) return '(absent)';
  if (step.kind === 'tool_call')
    return `${step.kind} ${step.name}\n${JSON.stringify(step.args, null, 2)}`;
  if (step.kind === 'tool_result')
    return `${step.kind} ${step.name ?? step.id}${step.isError ? ' (error)' : ''}\n${displayContent(step.content, false)}`;
  if ('content' in step)
    return `${step.kind}${step.kind === 'input' ? ` ${step.role}` : ''}\n${step.kind === 'text' ? displayContent(step.content, false) : step.content}`;
  return JSON.stringify(step, null, 2);
}

export function wordChanges(op: Op): string {
  if (op.type !== 'changed') return '';
  const structural = displayChanges(op);
  if (structural !== undefined)
    return structural.length
      ? structural.map((change) => field(change, Infinity)).join('\n')
      : 'JSON values unchanged (formatting differs)';
  const before = fullStep(op.a);
  const after = fullStep(op.b);
  const parts = diffWordsWithSpace(before, after);
  if (parts.every((part) => !part.added && !part.removed))
    return diffText(before, after)
      .changes.map((part) => part.value)
      .join('');
  return parts
    .map((part) =>
      part.added
        ? `{+${part.value}+}`
        : part.removed
          ? `[-${part.value}-]`
          : part.value,
    )
    .join('');
}

/** Wrap full content by terminal cells without losing text or emitting recorded controls. */
export function wrap(value: string, width: number): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return value.split('\n').flatMap((line) => {
    const safe = terminalLine(line, Infinity);
    const rows: string[] = [];
    let current = '';
    for (const { segment } of segmenter.segment(safe)) {
      if (
        current &&
        terminalLine(current + segment, width) !== current + segment
      ) {
        rows.push(current);
        current = '';
      }
      current += segment;
    }
    rows.push(current);
    return rows;
  });
}

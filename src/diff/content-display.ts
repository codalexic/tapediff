import { jsonContainer } from '../content-display.js';
import type { Op } from './align.js';
import { diffJson, type JsonChange } from './detail.js';

/** Presentation-only structural details; raw JSON diff output stays unchanged. */
export function contentChanges(
  before: string,
  after: string,
): JsonChange[] | undefined {
  const a = jsonContainer(before);
  const b = jsonContainer(after);
  if (a === undefined && b === undefined) return undefined;
  return diffJson(a ?? before, b ?? after);
}

export function displayChanges(op: Op): JsonChange[] | undefined {
  if (op.type !== 'changed') return undefined;
  if (
    (op.a.kind === 'text' && op.b.kind === 'text') ||
    (op.a.kind === 'tool_result' && op.b.kind === 'tool_result')
  ) {
    const changes = contentChanges(op.a.content, op.b.content);
    if (changes !== undefined)
      return [
        ...changes,
        ...(op.detail.kind === 'text' ? op.detail.fields : []),
      ];
  }
  return undefined;
}

import { diffArrays } from 'diff';
import type { Step } from '../steps.js';
import type { JsonValue } from '../tape/schema.js';
import { canonicalJson } from '../tape/normalize.js';
import { diffJson, diffText, type Detail } from './detail.js';

export type Op =
  | { type: 'equal'; aIndex: number; bIndex: number; a: Step; b: Step }
  | {
      type: 'changed';
      aIndex: number;
      bIndex: number;
      a: Step;
      b: Step;
      detail: Detail;
    }
  | { type: 'removed'; aIndex: number; a: Step }
  | { type: 'added'; bIndex: number; b: Step };

function key(step: Step): string {
  return JSON.stringify([
    step.kind,
    step.kind === 'input'
      ? step.role
      : step.kind === 'llm_call'
        ? step.model
        : step.kind === 'tool_call' || step.kind === 'tool_result'
          ? (step.name ?? null)
          : null,
  ]);
}

/** IDs, sequence numbers, providers and usage are transport/accounting metadata. */
function content(step: Step): JsonValue {
  switch (step.kind) {
    case 'llm_call':
      return { model: step.model, status: step.status };
    case 'tool_call':
      return step.args;
    case 'tool_result':
      return { content: step.content, isError: step.isError ?? false };
    case 'input':
    case 'text':
      return step.content;
    case 'error':
      return { status: step.status, message: step.message };
  }
}

function detail(a: Step, b: Step): Detail {
  if (a.kind === 'tool_call' && b.kind === 'tool_call')
    return { kind: 'json', changes: diffJson(a.args, b.args) };
  if (
    (a.kind === 'input' && b.kind === 'input') ||
    (a.kind === 'text' && b.kind === 'text') ||
    (a.kind === 'tool_result' && b.kind === 'tool_result')
  ) {
    const result = diffText(a.content, b.content);
    if (a.kind === 'tool_result' && b.kind === 'tool_result')
      result.fields = diffJson(
        { isError: a.isError ?? false },
        { isError: b.isError ?? false },
      );
    return result;
  }
  return { kind: 'fields', changes: diffJson(content(a), content(b)) };
}

/** Myers sequence alignment, matching keys first and then comparing behavior. */
export function align(a: readonly Step[], b: readonly Step[]): Op[] {
  const ops: Op[] = [];
  let ai = 0;
  let bi = 0;
  for (const part of diffArrays([...a], [...b], {
    comparator: (x, y) => key(x) === key(y),
  })) {
    for (let i = 0; i < part.value.length; i++) {
      if (part.removed) ops.push({ type: 'removed', aIndex: ai, a: a[ai++]! });
      else if (part.added) ops.push({ type: 'added', bIndex: bi, b: b[bi++]! });
      else {
        const left = a[ai]!;
        const right = b[bi]!;
        const pair = { aIndex: ai++, bIndex: bi++, a: left, b: right };
        ops.push(
          canonicalJson(content(left)) === canonicalJson(content(right))
            ? { type: 'equal', ...pair }
            : { type: 'changed', ...pair, detail: detail(left, right) },
        );
      }
    }
  }
  return ops;
}

import { diffLines, diffWords } from 'diff';
import type { JsonValue } from '../tape/schema.js';
import { canonicalJson } from '../tape/normalize.js';

export interface JsonChange {
  /** JSON Pointer; empty string denotes the root. Missing sides are omitted. */
  path: string;
  before?: JsonValue;
  after?: JsonValue;
}
export interface TextChange {
  type: 'equal' | 'added' | 'removed';
  value: string;
}
export type Detail =
  | { kind: 'json'; changes: JsonChange[] }
  | {
      kind: 'text';
      mode: 'words' | 'lines';
      changes: TextChange[];
      fields: JsonChange[];
    }
  | { kind: 'fields'; changes: JsonChange[] };

/** Structural JSON differ. Arrays retain order; object keys are sorted. */
export function diffJson(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path = '',
): JsonChange[] {
  if (before === after) return [];
  if (
    before !== undefined &&
    after !== undefined &&
    canonicalJson(before) === canonicalJson(after)
  )
    return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    if (Array.isArray(before) && Array.isArray(after)) {
      return Array.from(
        { length: Math.max(before.length, after.length) },
        (_, i) => diffJson(before[i], after[i], `${path}/${i}`),
      ).flat();
    }
    const a = before as Record<string, JsonValue>;
    const b = after as Record<string, JsonValue>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        diffJson(
          Object.hasOwn(a, key) ? a[key] : undefined,
          Object.hasOwn(b, key) ? b[key] : undefined,
          `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        ),
      );
  }
  return [
    {
      path,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  ];
}

export function diffText(
  a: string,
  b: string,
): Extract<Detail, { kind: 'text' }> {
  const mode =
    Math.max(a.length, b.length) > 200 || a.includes('\n') || b.includes('\n')
      ? 'lines'
      : 'words';
  let changes: TextChange[] = (
    mode === 'lines' ? diffLines(a, b) : diffWords(a, b)
  ).map((part) => ({
    type: part.added ? 'added' : part.removed ? 'removed' : 'equal',
    value: part.value,
  }));
  // diffWords ignores whitespace-only edits, which still change recorded output.
  if (a !== b && changes.every((part) => part.type === 'equal'))
    changes = [
      { type: 'removed', value: a },
      { type: 'added', value: b },
    ];
  return { kind: 'text', mode, changes, fields: [] };
}

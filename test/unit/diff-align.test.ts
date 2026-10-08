import { expect, it } from 'vitest';
import { align } from '../../src/diff/align.js';
import { diffJson, diffText } from '../../src/diff/detail.js';
import type { Step } from '../../src/steps.js';

const tool = (
  name: string,
  args = {},
): Extract<Step, { kind: 'tool_call' }> => ({
  kind: 'tool_call',
  id: name,
  name,
  args,
});
const text = (content: string): Step => ({ kind: 'text', content });
const types = (a: Step[], b: Step[]) => align(a, b).map((op) => op.type);

it('aligns insertions and deletions without shifting later matches', () => {
  const a = [tool('one'), tool('two')];
  const b = [tool('zero'), ...a, tool('three')];
  expect(types(a, b)).toEqual(['added', 'equal', 'equal', 'added']);
  expect(types(b, a)).toEqual(['removed', 'equal', 'equal', 'removed']);
  expect(align(a, b)[1]).toMatchObject({ aIndex: 0, bIndex: 1 });
});

it('reports a reorder as a removal and addition and preserves the LCS', () => {
  const a = [tool('one'), tool('two'), tool('three')];
  const b = [a[1]!, a[0]!, a[2]!];
  expect(types(a, b).filter((type) => type === 'equal')).toHaveLength(2);
  expect(types(a, b)).toContain('removed');
  expect(types(a, b)).toContain('added');
});

it('compares arguments structurally and ignores generated tool IDs', () => {
  const a = tool('weather', { city: 'Paris', units: 'C' });
  const b = {
    ...tool('weather', { units: 'C', city: 'Tokyo' }),
    id: 'different',
  };
  expect(align([a], [b])).toMatchObject([
    {
      type: 'changed',
      detail: {
        kind: 'json',
        changes: [{ path: '/city', before: 'Paris', after: 'Tokyo' }],
      },
    },
  ]);
  expect(
    types(
      [a],
      [{ ...tool('weather', { units: 'C', city: 'Paris' }), id: 'new' }],
    ),
  ).toEqual(['equal']);
});

it('diffs nested arrays by index, preserves missing/null and escapes JSON Pointers', () => {
  expect(
    diffJson(
      { list: [{ x: 1 }, null], 'a/b~': 1 },
      { list: [{ x: 2 }, null, true], 'a/b~': 2 },
    ),
  ).toEqual([
    { path: '/a~1b~0', before: 1, after: 2 },
    { path: '/list/0/x', before: 1, after: 2 },
    { path: '/list/2', after: true },
  ]);
  expect(diffJson({ value: null }, {})).toEqual([
    { path: '/value', before: null },
  ]);
  expect(diffJson({}, { value: null })).toEqual([
    { path: '/value', after: null },
  ]);
  expect(diffJson([], {})).toEqual([{ path: '', before: [], after: {} }]);
  expect(
    diffJson(JSON.parse('{"__proto__":1}') as { __proto__: number }, {}),
  ).toEqual([{ path: '/__proto__', before: 1 }]);
});

it('matches parallel tools by name, including repeated same-name calls in order', () => {
  const a = [
    tool('weather', { city: 'Paris' }),
    tool('time'),
    tool('weather', { city: 'Tokyo' }),
  ];
  const b = [
    tool('weather', { city: 'Paris' }),
    tool('extra'),
    tool('time'),
    tool('weather', { city: 'Berlin' }),
  ];
  expect(types(a, b)).toEqual(['equal', 'added', 'equal', 'changed']);
});

it('handles empty sequences and text changes', () => {
  expect(align([], [])).toEqual([]);
  expect(types([], [text('new')])).toEqual(['added']);
  expect(types([text('old')], [])).toEqual(['removed']);
  expect(align([text('hello Paris')], [text('hello Tokyo')])).toMatchObject([
    { type: 'changed', detail: { kind: 'text', mode: 'words' } },
  ]);
  expect(diffText('a\nb\n', 'a\nc\n')).toMatchObject({
    mode: 'lines',
    changes: [
      { type: 'equal', value: 'a\n' },
      { type: 'removed', value: 'b\n' },
      { type: 'added', value: 'c\n' },
    ],
  });
  expect(diffText('x'.repeat(201), 'y').mode).toBe('lines');
  expect(
    diffText('hello ', 'hello').changes.some((c) => c.type !== 'equal'),
  ).toBe(true);
});

it('treats tool result error flags and errors as behavioral changes', () => {
  const a: Step = {
    kind: 'tool_result',
    name: 'weather',
    id: 'old',
    content: 'no data',
  };
  expect(types([a], [{ ...a, id: 'new', isError: false }])).toEqual(['equal']);
  expect(align([a], [{ ...a, isError: true }])).toMatchObject([
    {
      type: 'changed',
      detail: { fields: [{ path: '/isError', before: false, after: true }] },
    },
  ]);
  expect(types([a], [{ ...a, content: 'data' }])).toEqual(['changed']);
  expect(
    align(
      [{ kind: 'error', status: 400, message: 'old' }],
      [{ kind: 'error', status: 500, message: 'new' }],
    ),
  ).toMatchObject([
    {
      type: 'changed',
      detail: {
        kind: 'fields',
        changes: [
          { path: '/message', before: 'old', after: 'new' },
          { path: '/status', before: 400, after: 500 },
        ],
      },
    },
  ]);
});

it('reconstructs both inputs across many deterministic insert/delete/reorder cases', () => {
  for (let seed = 0; seed < 100; seed++) {
    const a = Array.from({ length: seed % 13 }, (_, i) =>
      tool(String((seed + i * 7) % 5)),
    );
    const b = Array.from({ length: seed % 11 }, (_, i) =>
      tool(String((seed + i * 3) % 7)),
    );
    const ops = align(a, b);
    expect(ops.flatMap((op) => ('a' in op ? [op.a] : []))).toEqual(a);
    expect(ops.flatMap((op) => ('b' in op ? [op.b] : []))).toEqual(b);
    // Independent dynamic-programming LCS verifies a minimal edit script.
    const lcs = Array.from({ length: a.length + 1 }, () =>
      Array<number>(b.length + 1).fill(0),
    );
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        lcs[i]![j] =
          JSON.stringify(a[i - 1]) === JSON.stringify(b[j - 1])
            ? lcs[i - 1]![j - 1]! + 1
            : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
    expect(ops.filter((op) => op.type === 'equal').length).toBe(
      lcs[a.length]![b.length],
    );
  }
});

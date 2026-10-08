import { expect, it } from 'vitest';
import { textWindow } from '../../src/diff/text-window.js';
import { renderText } from '../../src/diff/render-text.js';
import { diffRuns, type Run } from '../../src/diff/index.js';

it.each(['input', 'text', 'tool_result'] as const)(
  'shows a late %s edit within terminal width',
  (kind) => {
    const before =
      'unchanged context '.repeat(40) +
      'Paris' +
      ' trailing context'.repeat(40);
    const after = before.replace('Paris', 'Tokyo');
    const run = (content: string): Run => ({
      name: null,
      path: 'example.tape',
      createdAt: '2026-01-01T00:00:00Z',
      steps: [
        kind === 'input'
          ? { kind, role: 'user', content }
          : kind === 'tool_result'
            ? { kind, id: 'tool', content }
            : { kind, content },
      ],
    });
    for (const width of [40, 80, 100]) {
      const output = renderText(
        diffRuns(run(before), run(after)),
        width,
        false,
      );
      expect(output).toContain('[-Paris-]{+Tokyo+}');
      expect(output).toContain('…');
      expect(output.split('\n').every((line) => line.length <= width)).toBe(
        true,
      );
    }
  },
);

it('handles insertions, deletions, whitespace, control characters and wide context', () => {
  expect(textWindow('hello world', 'hello new world', 80)).toContain(
    '{+new +}',
  );
  expect(textWindow('hello old world', 'hello world', 80)).toContain(
    '[-old -]',
  );
  expect(textWindow('a b', 'a  b', 80)).toContain('[- -]{+  +}');
  const prefix = '旅😀'.repeat(60);
  expect(textWindow(prefix + ' Paris', prefix + ' Tokyo', 40)).toContain(
    '[-Paris-]{+Tokyo+}',
  );
  expect(textWindow('safe', '\x1b[2J', 80)).not.toContain('\x1b');
  expect(textWindow('before', 'after', 1)).toBe('…');
  expect(
    textWindow(
      'context '.repeat(100) + 'before',
      'context '.repeat(100) + 'after',
      1,
    ),
  ).toBe('…');
});

it('shows late changes in error messages and string tool arguments', () => {
  const before = 'unchanged context '.repeat(40) + 'Paris';
  const after = before.replace('Paris', 'Tokyo');
  for (const kind of ['error', 'tool_call'] as const) {
    const run = (content: string): Run => ({
      name: null,
      path: 'example.tape',
      createdAt: '2026-01-01T00:00:00Z',
      steps: [
        kind === 'error'
          ? { kind, status: 500, message: content }
          : { kind, id: 'tool', name: 'lookup', args: { prompt: content } },
      ],
    });
    expect(renderText(diffRuns(run(before), run(after)), 60, false)).toContain(
      '[-Paris-]{+Tokyo+}',
    );
  }
});

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DiffViewer } from '../../src/tui/view.js';
import { diffRuns, type Run } from '../../src/diff/index.js';
import type { Step } from '../../src/steps.js';
import { wrap } from '../../src/tui/detail.js';

const update = (action: () => void) =>
  act(() => Promise.resolve().then(action));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await update(() => {
    cleanup();
  });
});
const run = (name: string, steps: Step[]): Run => ({
  name,
  path: `${name}.tape`,
  createdAt: '2026-01-01T00:00:00Z',
  steps,
});
const steps: Step[] = [
  { kind: 'input', role: 'user', content: 'Weather in Paris?' },
  {
    kind: 'llm_call',
    provider: 'openai',
    seq: 0,
    model: 'gpt-4.1',
    status: 200,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.001,
    latencyMs: 500,
  },
  {
    kind: 'tool_call',
    id: 'a',
    name: 'weather',
    args: { city: 'Paris', units: 'C' },
  },
  { kind: 'tool_result', id: 'a', name: 'weather', content: 'Sunny' },
  { kind: 'text', content: 'It is sunny.' },
];
const candidate = steps.map((step): Step =>
  step.kind === 'input'
    ? { ...step, content: 'Weather in Tokyo?' }
    : step.kind === 'tool_call'
      ? { ...step, args: { city: 'Tokyo', units: 'C' } }
      : step,
);
candidate.push({ kind: 'error', status: 500, message: 'Oops' });
const diff = diffRuns(run('baseline', steps), run('candidate', candidate));
type Screen = ReturnType<typeof render>;
async function mount(element: ReactElement): Promise<Screen> {
  let screen!: Screen;
  await update(() => {
    screen = render(element);
  });
  return screen;
}
async function key(screen: Screen, value: string) {
  await update(() => {
    screen.stdin.write(value);
  });
}
async function open(columns = 100, rows = 18) {
  return mount(
    <DiffViewer diff={diff} columns={columns} rows={rows} color={false} />,
  );
}

it('renders aligned panes and navigates arrows, j/k, pages, and boundaries', async () => {
  const screen = await open(100, 10);
  expect(screen.lastFrame()).toMatchSnapshot('wide');
  await key(screen, 'j');
  expect(screen.lastFrame()).toContain('2/6');
  await key(screen, '\x1b[B');
  expect(screen.lastFrame()).toContain('3/6');
  await key(screen, 'k');
  expect(screen.lastFrame()).toContain('2/6');
  await key(screen, '\x1b[A');
  expect(screen.lastFrame()).toContain('1/6');
  await key(screen, '\x1b[6~');
  expect(screen.lastFrame()).toContain('4/6');
  await key(screen, '\x1b[5~');
  expect(screen.lastFrame()).toContain('1/6');
  await key(screen, 'G');
  expect(screen.lastFrame()).toContain('6/6');
  expect(screen.lastFrame()).toMatchSnapshot('bottom');
  await key(screen, 'j');
  expect(screen.lastFrame()).toContain('6/6');
  await key(screen, 'g');
  expect(screen.lastFrame()).toContain('1/6');
});

it('jumps to next/previous differences with wraparound and toggles both filter keys', async () => {
  const screen = await open();
  await key(screen, 'n');
  expect(screen.lastFrame()).toContain('3/6');
  await key(screen, 'n');
  expect(screen.lastFrame()).toContain('6/6');
  await key(screen, 'n');
  expect(screen.lastFrame()).toContain('1/6');
  await key(screen, 'N');
  expect(screen.lastFrame()).toContain('6/6');
  await key(screen, '/');
  expect(screen.lastFrame()).toContain('3/3');
  expect(screen.lastFrame()).not.toContain('llm_call');
  expect(screen.lastFrame()).toMatchSnapshot('filtered');
  await key(screen, 'd');
  expect(screen.lastFrame()).toContain('6/6');
  await key(screen, 'g');
  await key(screen, 'j');
  await key(screen, 'd');
  expect(screen.lastFrame()).toContain('2/3');
});

it('expands full arguments and word changes, then collapses', async () => {
  const screen = await open();
  await key(screen, 'n');
  await key(screen, '\r');
  expect(screen.lastFrame()).toContain('"units": "C"');
  expect(screen.lastFrame()).toContain('[-Paris-]{+Tokyo+}');
  expect(screen.lastFrame()).toMatchSnapshot('expanded');
  await key(screen, '\r');
  expect(screen.lastFrame()).not.toContain('Word diff:');
  expect(screen.lastFrame()).toContain('3/6');
});

it('stacks narrow terminals and responds to live resize', async () => {
  const screen = await open(80);
  expect(screen.lastFrame()).toContain('stacked');
  expect(screen.lastFrame()).toContain('a: input user');
  expect(screen.lastFrame()).toContain('b: input user');
  expect(screen.lastFrame()).not.toContain(' │ ');
  expect(screen.lastFrame()).toMatchSnapshot('narrow');
  await update(() => {
    screen.rerender(<DiffViewer diff={diff} rows={18} color={false} />);
  });
  expect(screen.lastFrame()).toContain('side by side');
  Object.defineProperty(screen.stdout, 'columns', {
    value: 79,
    configurable: true,
  });
  await update(() => {
    screen.stdout.emit('resize');
  });
  expect(screen.lastFrame()).toContain('stacked');
});

it('scrolls all expanded content and escapes terminal controls', async () => {
  const content =
    Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') +
    '\n\x1b[2JEND';
  const long = diffRuns(
    run('a', [{ kind: 'text', content }]),
    run('b', [{ kind: 'text', content }]),
  );
  const screen = await mount(
    <DiffViewer diff={long} columns={80} rows={14} color={false} />,
  );
  await key(screen, '\r');
  expect(screen.lastFrame()).toContain('a: line 0');
  await key(screen, 'j');
  expect(screen.lastFrame()).toContain('lines 2-');
  await key(screen, '\x1b[6~');
  expect(screen.lastFrame()).toContain('lines 9-');
  await key(screen, 'G');
  expect(screen.lastFrame()).toContain('b: \\u001b[2JEND');
  expect(screen.lastFrame()).not.toContain('\x1b');
  await key(screen, 'g');
  expect(screen.lastFrame()).toContain('a: line 0');
});

it.each(['q', '\x1b'])(
  'quits on %j and removes input listeners',
  async (quit) => {
    const screen = await open();
    await key(screen, quit);
    expect(screen.stdin.listenerCount('readable')).toBe(0);
  },
);

it('handles empty and identical filtered views', async () => {
  const same = diffRuns(run('a', steps), run('b', steps));
  const screen = await mount(
    <DiffViewer diff={same} columns={100} color={false} />,
  );
  await key(screen, 'd');
  expect(screen.lastFrame()).toContain('No differences');
  await key(screen, 'n');
  await key(screen, 'G');
  await key(screen, '\r');
  expect(screen.lastFrame()).toContain('0/0');
  expect(screen.lastFrame()).toMatchSnapshot('no differences');
  await update(() => {
    screen.rerender(
      <DiffViewer diff={diffRuns(run('a', []), run('b', []))} color={false} />,
    );
  });
  await key(screen, 'd');
  expect(screen.lastFrame()).toContain('No steps');
});

it('wraps Unicode and multiline content without loss', () => {
  const text = '晴天🌤️e\u0301 abc';
  expect(wrap(text, 4).join('')).toBe(text);
  expect(wrap('a\nb', 4)).toEqual(['a', 'b']);
});

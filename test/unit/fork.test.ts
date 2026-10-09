import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createForkMatcher } from '../../src/proxy/fork-match.js';
import { forkOutputPath } from '../../src/commands/fork.js';
import { matchKey } from '../../src/tape/normalize.js';
import {
  exchangeSchema,
  parseTapeLine,
  tapeHeaderSchema,
  type Exchange,
} from '../../src/tape/schema.js';
import { toSteps } from '../../src/steps.js';
import { renderSteps } from '../../src/commands/show.js';
import { diffRuns } from '../../src/diff/index.js';
import { renderJson } from '../../src/diff/render-json.js';
import { exchange, header, fixtureText } from './tape-fixtures.js';

function call(
  seq: number,
  endpoint = '/v1/chat/completions',
  provider: Exchange['provider'] = 'openai',
): Exchange {
  const request = {
    method: 'POST',
    path: endpoint,
    headers: {},
    body: { value: seq },
  };
  return {
    ...exchange,
    id: seq,
    seq,
    provider,
    endpoint,
    request,
    matchKey: matchKey(request.method, endpoint, request.body),
  };
}
const take = (matcher: ReturnType<typeof createForkMatcher>, entry: Exchange) =>
  matcher.take(entry.provider, entry.request);

it('assigns positions in seq order regardless of the incoming match key and counts changed calls', () => {
  const warn = vi.fn();
  const matcher = createForkMatcher([call(7), call(3)], 3, warn);
  expect(take(matcher, call(99))?.seq).toBe(3);
  expect(take(matcher, call(98))?.seq).toBe(7);
  expect(take(matcher, call(3))).toBeUndefined();
  expect(take(matcher, call(7))).toBeUndefined();
  expect(matcher.stats).toEqual({ live: true, changed: 2, unconsumed: 0 });
  expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
    'fork: call #1 served from tape although its request changed\n',
    'fork: call #2 served from tape although its request changed\n',
  ]);
});

it('an endpoint change switches permanently without consuming the prefix', () => {
  const warn = vi.fn();
  const matcher = createForkMatcher([call(0), call(1)], 3, warn);
  expect(take(matcher, call(0, '/v1/responses'))).toBeUndefined();
  expect(take(matcher, call(0))).toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'fork: call #1 endpoint changed (/v1/chat/completions -> /v1/responses), going live early\n',
  );
  expect(matcher.stats).toMatchObject({ live: true, unconsumed: 2 });
});

it('compares normalized endpoints for positional requests', () => {
  const matcher = createForkMatcher([call(0)], 2);
  expect(take(matcher, call(0, '/openai/v1/chat/completions?x=1'))?.seq).toBe(
    0,
  );
});

it.each([2, 100])(
  'goes live on exhaustion with --at %i and warns once',
  (at) => {
    const warn = vi.fn();
    const matcher = createForkMatcher([], at, warn);
    expect(take(matcher, call(0))).toBeUndefined();
    expect(take(matcher, call(1))).toBeUndefined();
    expect(matcher.stats.live).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'fork: recorded calls exhausted at call #1, going live\n',
    );
  },
);

it('serves the whole available prefix when --at exceeds tape length', () => {
  const warn = vi.fn();
  const matcher = createForkMatcher([call(0)], 10, warn);
  expect(take(matcher, call(0))?.seq).toBe(0);
  expect(take(matcher, call(0))).toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'fork: recorded calls exhausted at call #2, going live\n',
  );
});

it('--at 1 goes live immediately without an exhaustion warning', () => {
  const warn = vi.fn();
  const matcher = createForkMatcher([call(0)], 1, warn);
  expect(take(matcher, call(0))).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  expect(matcher.stats).toMatchObject({ live: true, unconsumed: 1 });
});

it.each([undefined, 2])(
  'unknown misses and matches do not change LLM numbering (at=%s)',
  (at) => {
    const warn = vi.fn();
    const generic = call(8, '/health', 'unknown');
    const matcher = createForkMatcher([generic, call(0), call(1)], at, warn);
    expect(take(matcher, call(99, '/health', 'unknown'))).toBeUndefined();
    expect(matcher.stats.live).toBe(false);
    expect(take(matcher, generic)?.seq).toBe(8);
    expect(take(matcher, call(0))?.seq).toBe(0);
    expect(matcher.stats.live).toBe(false);
    expect(take(matcher, call(1))?.seq).toBe(at ? undefined : 1);
    expect(warn).not.toHaveBeenCalled();
  },
);

it('positional unknown matches remain available after the LLM switch', () => {
  const generic = call(8, '/health', 'unknown');
  const matcher = createForkMatcher([generic, call(0)], 1);
  expect(take(matcher, call(0))).toBeUndefined();
  expect(take(matcher, generic)?.seq).toBe(8);
});

it('divergence uses strict FIFO per key, then goes live permanently for every route', () => {
  const first = call(0);
  const duplicate = { ...first, seq: 4, id: 4 };
  const generic = call(8, '/health', 'unknown');
  const warn = vi.fn();
  const matcher = createForkMatcher(
    [duplicate, call(1), first, generic],
    undefined,
    warn,
  );
  expect(take(matcher, call(1))?.seq).toBe(1);
  expect(take(matcher, first)?.seq).toBe(0);
  expect(take(matcher, first)?.seq).toBe(4);
  expect(take(matcher, first)).toBeUndefined();
  expect(take(matcher, generic)).toBeUndefined();
  expect(warn.mock.calls[0]?.[0]).toBe(
    'fork: diverged at call #4 (POST /v1/chat/completions), going live\n',
  );
  expect(warn.mock.calls[1]?.[0]).toContain('No unconsumed recorded request');
  expect(matcher.stats).toMatchObject({ live: true, unconsumed: 0 });
});

it('redacts divergence diagnostics and shows the changed request', () => {
  const warn = vi.fn();
  const matcher = createForkMatcher([call(0)], undefined, warn);
  matcher.take('openai', {
    ...call(0).request,
    body: { api_key: 'private', value: 1 },
  });
  const output = warn.mock.calls.flat().join('');
  expect(output).toContain('recorded request');
  expect(output).toContain('incoming request');
  expect(output).toContain('[REDACTED]');
  expect(output).not.toContain('private');
});

it.each([path.posix, path.win32])(
  'derives output paths using the selected path conventions',
  (paths) => {
    expect(forkOutputPath(paths.join('runs', 'a.tape'), paths)).toBe(
      paths.join('runs', 'a.fork.tape'),
    );
    expect(forkOutputPath('a.tape', paths)).toBe('a.fork.tape');
    expect(forkOutputPath('a', paths)).toBe('a.fork.tape');
    expect(forkOutputPath('a.tape.tape', paths)).toBe('a.tape.fork.tape');
  },
);

it('roundtrips optional provenance while retaining v1 records', () => {
  const forkedFrom = {
    tape: 'runs/a.tape',
    at: 2,
    mode: 'positional',
    sourceCreatedAt: header.createdAt,
  };
  expect(tapeHeaderSchema.parse({ ...header, forkedFrom }).forkedFrom).toEqual(
    forkedFrom,
  );
  expect(
    tapeHeaderSchema.parse({
      ...header,
      forkedFrom: { ...forkedFrom, at: null, mode: 'divergence' },
    }).forkedFrom?.at,
  ).toBeNull();
  expect(
    exchangeSchema.parse({ ...exchange, servedFrom: { seq: 7 } }).servedFrom,
  ).toEqual({ seq: 7 });
  for (const [index, line] of fixtureText.trim().split('\n').entries())
    expect(parseTapeLine(line, index + 1)).toBeDefined();
  expect(tapeHeaderSchema.parse(header).forkedFrom).toBeUndefined();
  expect(exchangeSchema.parse(exchange).servedFrom).toBeUndefined();
  expect(
    exchangeSchema.safeParse({ ...exchange, servedFrom: { seq: -1 } }).success,
  ).toBe(false);
});

it('carries provenance into show steps but keeps diff equality and JSON unchanged', () => {
  const steps = toSteps([{ ...exchange, servedFrom: { seq: 7 } }]);
  expect(steps.find((step) => step.kind === 'llm_call')).toHaveProperty(
    'servedFrom',
    { seq: 7 },
  );
  expect(renderSteps(steps)).toContain('#1 (from tape)');
  const run = {
    name: null,
    path: '',
    createdAt: header.createdAt,
    steps: toSteps([exchange]),
  };
  const diff = diffRuns(run, { ...run, steps });
  expect(diff.identical).toBe(true);
  expect(renderJson(diff)).toBe(renderJson(diffRuns(run, run)));
  const unknown = { ...exchange, seq: 0, provider: 'unknown' as const };
  expect(renderSteps(toSteps([unknown, { ...exchange, seq: 1 }]))).toContain(
    '#1',
  );
  expect(
    renderSteps(toSteps([unknown, { ...exchange, seq: 1 }])),
  ).not.toContain('#2');
});

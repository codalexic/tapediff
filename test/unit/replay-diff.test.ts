import { expect, it } from 'vitest';
import { replayMissDiff } from '../../src/proxy/replay.js';
import { exchange } from './tape-fixtures.js';

it('chooses the nearest request by shared canonical lines on the same endpoint', () => {
  const candidate = (body: typeof exchange.request.body) => ({
    ...exchange,
    endpoint: '/v1/responses',
    request: { ...exchange.request, path: '/v1/responses', body },
  });
  const diff = replayMissDiff(
    {
      method: 'POST',
      path: '/v1/responses',
      body: { model: 'gpt-4o', input: 'new', temperature: 0 },
    },
    [
      candidate({ model: 'other', input: 'distant', temperature: 1 }),
      candidate({ temperature: 0, input: 'near', model: 'gpt-4o' }),
    ],
  );
  expect(diff).toContain('-    "input": "near"');
  expect(diff).toContain('+    "input": "new"');
  expect(diff).not.toContain('distant');
});

it('redacts secret request contents and optional patterns before printing diffs', () => {
  const previous = process.env.TAPEDIFF_REDACT;
  process.env.TAPEDIFF_REDACT = 'private-value';
  try {
    const output = replayMissDiff(
      {
        method: 'POST',
        path: '/v1/responses',
        body: {
          input: 'sk-12345678901234567890 private-value',
          api_key: 'shortsecret',
        },
      },
      [],
    );
    expect(output).toContain('No unconsumed recorded request');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('shortsecret');
    expect(output).not.toContain('private-value');
    expect(output).not.toContain('sk-12345678901234567890');
  } finally {
    if (previous === undefined) delete process.env.TAPEDIFF_REDACT;
    else process.env.TAPEDIFF_REDACT = previous;
  }
});

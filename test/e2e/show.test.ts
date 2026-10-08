import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { run } from '../helpers/cli.js';
import { readTape } from '../../src/tape/io.js';
import { toSteps } from '../../src/steps.js';
import { stepTotals } from '../../src/commands/show.js';

const tape = fileURLToPath(
  new URL('../fixtures/steps/chat-json.tape', import.meta.url),
);

it('show respects NO_COLOR and supports FORCE_COLOR when piped', async () => {
  for (const env of [
    { NO_COLOR: '1' },
    { NO_COLOR: undefined, FORCE_COLOR: '1' },
  ]) {
    const result = await run(['show', tape], env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.includes('\x1b')).toBe(env.NO_COLOR === undefined);
    expect(result.stdout).toContain('#1  gpt-4.1  1,204→88 tok');
    expect(result.stdout).toContain('→ tool_call get_weather {"city":"Paris"}');
    expect(result.stdout).toContain('← tool_result get_weather "18°C, sunny"');
    expect(result.stdout).toContain(
      '✓ final: "It\'s 18°C and sunny in Paris."',
    );
    expect(result.stdout).toContain('total: 2 calls · 2.6k tokens');
  }
});

it('show --json prints the complete versioned schema, original header, steps and totals', async () => {
  const data = await readTape(tape);
  const steps = toSteps(data.exchanges);
  const result = await run(['show', tape, '--json']);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    header: data.header,
    steps,
    totals: stepTotals(steps),
  });
});

it('show reports missing tapes as a usage error', async () => {
  const result = await run(['show', `${tape}.missing`]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('cannot read tape: missing or invalid tape');
});

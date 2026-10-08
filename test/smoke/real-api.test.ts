import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { readTape } from '../../src/tape/io.js';
import {
  cli,
  exampleEnv,
  root,
  runExample,
} from '../helpers/example-process.js';

for (const [provider, variable] of [
  ['openai', 'OPENAI_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
] as const) {
  const key = process.env[variable];
  if (!key)
    console.info(`SKIP real ${provider} smoke: ${variable} is not set.`);
  it.skipIf(!key)(
    `records one real ${provider} call and replays without keys`,
    async () => {
      const dir = await mkdtemp(
        path.join(tmpdir(), `tapediff-smoke-${provider}-`),
      );
      try {
        const tape = path.join(dir, 'real.tape');
        const command = [
          process.execPath,
          path.join(root, 'test/smoke/one-call.mjs'),
          provider,
        ];
        const recorded = await runExample(
          [cli, 'record', '--out', tape, '--', ...command],
          root,
          {
            ...exampleEnv(),
            [variable]: key,
            // Ignore inherited custom endpoints: secrets go only to the intended provider.
            TAPEDIFF_OPENAI_UPSTREAM: 'https://api.openai.com',
            TAPEDIFF_ANTHROPIC_UPSTREAM: 'https://api.anthropic.com',
          },
          45_000,
        );
        // Boolean assertions avoid printing a key as an assertion's expected value.
        const raw = await readFile(tape, 'utf8');
        for (const secret of [
          process.env.OPENAI_API_KEY,
          process.env.ANTHROPIC_API_KEY,
        ]) {
          if (secret) {
            expect(
              raw.includes(secret),
              'tape must not contain credentials',
            ).toBe(false);
            expect(
              (recorded.stdout + recorded.stderr).includes(secret),
              'logs must not contain credentials',
            ).toBe(false);
          }
        }
        expect(raw).not.toMatch(/"(?:authorization|x-api-key|api-key)"\s*:/i);
        // Do not include provider error output in a failing assertion.
        expect(recorded.code, `real ${provider} recording must succeed`).toBe(
          0,
        );
        const data = await readTape(tape);
        expect(data.exchanges).toHaveLength(1);
        expect(data.exchanges[0]?.response.status).toBe(200);
        expect(recorded.stdout.trim().length).toBeGreaterThan(0);
        // Both keys are absent; inaccessible upstreams prove replay needs no provider.
        const offline = exampleEnv();
        delete offline.OPENAI_API_KEY;
        delete offline.ANTHROPIC_API_KEY;
        const replayed = await runExample(
          [cli, 'replay', tape, '--', ...command],
          root,
          offline,
        );
        expect(replayed.code, `offline ${provider} replay must succeed`).toBe(
          0,
        );
        expect(replayed.stdout).toBe(recorded.stdout);
        expect(replayed.stderr).toContain('0 misses');
        expect(replayed.stderr).not.toContain('never requested');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

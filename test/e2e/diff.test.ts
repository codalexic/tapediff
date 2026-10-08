import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { run } from '../helpers/cli.js';
import { diffSchema } from '../helpers/diff-schema.js';

const fixture = fileURLToPath(
  new URL('../fixtures/steps/chat-json.tape', import.meta.url),
);
const agent = fileURLToPath(
  new URL('./agents/diff-prompt.mjs', import.meta.url),
);

it('records different prompts against a local fake upstream, then diffs the real CLI', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-diff-'));
  const fake = await fakeUpstream({
    responseBody: (request) => ({
      model: 'gpt-4.1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify(request.body.messages),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });
  try {
    const a = path.join(dir, 'a.tape');
    const b = path.join(dir, 'b.tape');
    for (const [tape, prompt] of [
      [a, 'Paris'],
      [b, 'Tokyo'],
    ]) {
      const recorded = await run(
        [
          'record',
          '--out',
          tape!,
          '--name',
          prompt!,
          '--',
          process.execPath,
          agent,
          prompt!,
        ],
        { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
      );
      expect(recorded.code, recorded.stderr).toBe(0);
    }
    expect(fake.requests).toHaveLength(2);
    const result = await run(['diff', a, b, '--json']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toBe('');
    const diff = diffSchema.parse(JSON.parse(result.stdout));
    expect(diff).toMatchObject({
      identical: false,
      firstDivergence: { index: 0, a: { kind: 'input', role: 'user' } },
      a: { name: 'Paris', path: a },
      b: { name: 'Tokyo', path: b },
      finalText: { changed: true },
    });
    for (const env of [
      { NO_COLOR: '1' },
      { NO_COLOR: undefined, FORCE_COLOR: '1' },
    ]) {
      const text = await run(['diff', a, b, '--no-color'], env);
      expect(text.code, text.stderr).toBe(1);
      expect(text.stdout).toContain('first divergence at step 1');
      expect(text.stdout).toContain('✗ behavior differs');
      expect(text.stdout).not.toContain('\x1b');
    }
    const identical = await run(['diff', a, a, '--json']);
    expect(identical.code).toBe(0);
    expect(diffSchema.parse(JSON.parse(identical.stdout)).identical).toBe(true);
    const invalid = path.join(dir, 'invalid.tape');
    await writeFile(invalid, 'invalid');
    expect((await run(['diff', a, invalid])).code).toBe(2);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

it('supports FORCE_COLOR for piped terminal captures', async () => {
  const result = await run(['diff', fixture, fixture], {
    NO_COLOR: undefined,
    FORCE_COLOR: '1',
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('✓ identical behavior');
  expect(result.stdout).toContain('\x1b');
});

it('returns exit 2 for missing paths and usage errors', async () => {
  for (const args of [
    ['diff'],
    ['diff', fixture],
    ['diff', fixture, `${fixture}.missing`],
    ['diff', fixture, fixture, '--unknown'],
  ])
    expect((await run(args)).code).toBe(2);
});

it('falls back from TUI to text without hanging non-TTY CI and preserves exit codes', async () => {
  for (const other of [fixture, fixture.replace('chat-json', 'chat-error')]) {
    const text = await run(['diff', fixture, other]);
    const tui = await run(['diff', fixture, other, '--tui']);
    expect(tui.code).toBe(text.code);
    expect(tui.stdout).toBe(text.stdout);
    expect(tui.stderr).toContain('warning: --tui requires a TTY');
  }
  const json = await run(['diff', fixture, fixture, '--tui', '--json']);
  expect(json.code).toBe(0);
  expect(json.stderr).toBe('');
  expect(diffSchema.parse(JSON.parse(json.stdout)).identical).toBe(true);
});

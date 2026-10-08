import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createProgram } from '../../src/cli-program.js';

const root = new URL('../../', import.meta.url);
const examples = await readdir(new URL('examples/', root), {
  withFileTypes: true,
});
const files = ['README.md'];
for (const entry of examples) {
  if (!entry.isDirectory()) continue;
  const directory = `examples/${entry.name}/`;
  if ((await readdir(new URL(directory, root))).includes('README.md'))
    files.push(`${directory}README.md`);
}

/** Parse with the real Commander configuration but replace every action before use. */
async function validate(command: string): Promise<void> {
  const program = createProgram().configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  let invoked = false;
  for (const subcommand of program.commands)
    subcommand
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
      .action(() => {
        invoked = true;
      });
  const args = command
    .replace(/^npx\s+/, '')
    .match(/"[^"]*"|'[^']*'|\S+/g)!
    .slice(1)
    .map((arg) => arg.replace(/^["']|["']$/g, ''));
  await program.parseAsync(args, { from: 'user' });
  expect(invoked, command).toBe(true);
}

it.each(files)(
  'validates every tapediff shell block in %s against Commander',
  async (file) => {
    const source = await readFile(new URL(file, root), 'utf8');
    const blocks = [...source.matchAll(/```sh\r?\n([\s\S]*?)\r?\n```/g)];
    let commands = 0;
    for (const block of blocks) {
      for (const command of block[1]!
        .split(/\r?\n/)
        .filter((line) => /^(?:npx\s+)?tapediff\b/.test(line))) {
        commands++;
        await validate(command);
      }
    }
    expect(commands).toBeGreaterThan(0);
  },
);

it('rejects invented subcommands/flags while leaving child flags alone', async () => {
  await expect(validate('tapediff invent')).rejects.toThrow();
  await expect(validate('tapediff show a.tape --invent')).rejects.toThrow();
  await expect(
    validate('tapediff replay a.tape --pace invented -- node agent.mjs'),
  ).rejects.toThrow();
  await validate('tapediff replay a.tape -- node agent.mjs --child-flag');
});

it('keeps generated help synchronized with the real Commander configuration', async () => {
  const reference = await readFile(new URL('docs/cli.md', root), 'utf8');
  const program = createProgram();
  expect(reference).toContain(program.helpInformation().trimEnd());
  for (const command of program.commands)
    expect(reference).toContain(command.helpInformation().trimEnd());
});

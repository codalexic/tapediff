import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import spawn from 'cross-spawn';

const root = fileURLToPath(new URL('../', import.meta.url));
const sections = [
  '',
  'record',
  'replay',
  'fork',
  'diff',
  'show',
  'export',
  'test',
  'help',
]
  .map((command) => {
    const args = command ? [command, '--help'] : ['--help'];
    const result = spawn.sync(process.execPath, ['dist/cli.js', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return `### ${command || 'Global'}\n\n\`\`\`text\n${result.stdout.trimEnd()}\n\`\`\``;
  })
  .join('\n\n');
const target = new URL('../docs/cli.md', import.meta.url);
const original = await readFile(target, 'utf8');
await writeFile(
  target,
  original.replace(
    /<!-- help:start -->[\s\S]*<!-- help:end -->/,
    `<!-- help:start -->\n${sections}\n<!-- help:end -->`,
  ),
);

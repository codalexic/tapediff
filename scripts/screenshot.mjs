import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import spawn from 'cross-spawn';

const root = fileURLToPath(new URL('../', import.meta.url));
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const palette = [
  '#c9d1d9',
  '#ff7b72',
  '#7ee787',
  '#e3b341',
  '#79c0ff',
  '#d2a8ff',
  '#76e3ea',
  '#e6edf3',
];

/** Convert the CLI's SGR colors/bold/dim to SVG text, without external assets. */
function terminalSvg(output, command) {
  const rows = [`$ ${command}`, '', ...output.trimEnd().split(/\r?\n/)];
  const height = 70 + rows.length * 22;
  let fill = palette[7],
    bold = false,
    dim = false;
  const text = rows
    .map((row, index) => {
      let spans = '';
      // SGR control sequences are precisely the input this converter must parse.
      // eslint-disable-next-line no-control-regex
      for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
        if (part.startsWith('\x1b[')) {
          for (const code of part.slice(2, -1).split(';').map(Number)) {
            if (code === 0) {
              fill = palette[7];
              bold = false;
              dim = false;
            } else if (code === 1) bold = true;
            else if (code === 2) dim = true;
            else if (code === 22) {
              bold = false;
              dim = false;
            } else if (code === 39) fill = palette[7];
            else if (code >= 30 && code <= 37) fill = palette[code - 30];
            else throw new Error(`Unsupported ANSI style: ${code}`);
          }
        } else if (part) {
          if (part.includes('\x1b'))
            throw new Error('Unsupported terminal escape');
          spans += `<tspan fill="${fill}" font-weight="${bold ? 700 : 400}" opacity="${dim ? 0.7 : 1}">${escape(part)}</tspan>`;
        }
      }
      return `<text x="24" y="${70 + index * 22}" xml:space="preserve">${spans}</text>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${escape(command)}</title>
<desc id="desc">Actual tapediff CLI output from the committed Python example tapes. Mock model data; costs and timings are illustrative, not benchmarks.</desc>
<rect width="1080" height="${height}" rx="12" fill="#0d1117"/>
<path d="M12 0h1056q12 0 12 12v28H0V12Q0 0 12 0" fill="#21262d"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="44" cy="20" r="6" fill="#febc2e"/><circle cx="66" cy="20" r="6" fill="#28c840"/>
<g font-family="'DejaVu Sans Mono',Consolas,'Liberation Mono',monospace" font-size="16">${text}</g>
</svg>\n`;
}

await mkdir(path.join(root, 'docs/assets'), { recursive: true });
for (const [name, args, expected] of [
  ['diff', ['diff', 'tapes/paris.tape', 'regressions/paris-v2.tape'], 1],
  ['show', ['show', 'tapes/paris.tape'], 0],
]) {
  const env = { ...process.env, FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  const result = spawn.sync(
    process.execPath,
    [path.join(root, 'dist/cli.js'), ...args],
    {
      cwd: path.join(root, 'examples/python-openai'),
      env,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  if (result.error) throw result.error;
  if (
    result.status !== expected ||
    result.stderr ||
    !result.stdout.includes('\x1b[')
  )
    throw new Error(
      `Unexpected ${name} capture (exit ${result.status}): ${result.stderr}`,
    );
  await writeFile(
    path.join(root, `docs/assets/${name}.svg`),
    terminalSvg(result.stdout, `tapediff ${args.join(' ')}`),
  );
  process.stdout.write(
    `Generated docs/assets/${name}.svg from CLI output (exit ${result.status})\n`,
  );
}

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import spawn from 'cross-spawn';
import { startMock } from '../examples/_mock/mock-llm.mjs';
import { pythonEnv } from '../examples/_mock/python-env.mjs';

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
  const width = Math.max(
    1080,
    48 +
      Math.ceil(
        Math.max(...rows.map((row) => stripVTControlCharacters(row).length)) *
          9.65,
      ),
  );
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${escape(command)}</title>
<desc id="desc">Actual tapediff CLI output from the Python examples. Mock model data; costs and timings are illustrative, not benchmarks.</desc>
<rect width="${width}" height="${height}" rx="12" fill="#0d1117"/>
<path d="M12 0h${width - 24}q12 0 12 12v28H0V12Q0 0 12 0" fill="#21262d"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="44" cy="20" r="6" fill="#febc2e"/><circle cx="66" cy="20" r="6" fill="#28c840"/>
<g font-family="'DejaVu Sans Mono',Consolas,'Liberation Mono',monospace" font-size="16">${text}</g>
</svg>\n`;
}

const cwd = await mkdtemp(path.join(tmpdir(), 'tapediff-screenshot-'));
const mock = await startMock();
try {
  const source = path.join(root, 'examples/python-langgraph');
  await mkdir(path.join(cwd, 'tapes'));
  for (const file of [
    'agent.py',
    'agent_v2.py',
    'tapediff_tools.py',
    'tapes/trip.tape',
  ])
    await copyFile(path.join(source, file), path.join(cwd, file));
  const env = pythonEnv('python-langgraph', {
    ...process.env,
    OPENAI_API_KEY: 'tapediff-local-mock',
    OPENAI_BASE_URL: '',
    OPENAI_API_BASE: '',
    TAPEDIFF_OPENAI_UPSTREAM: mock.url,
    TAPEDIFF_REDACT: '',
    TAPEDIFF_TAPE: '',
    FORCE_COLOR: '1',
    LANGSMITH_TRACING: 'false',
    LANGCHAIN_TRACING_V2: 'false',
    NO_PROXY: '127.0.0.1,localhost',
    PYTHONUNBUFFERED: '1',
  });
  delete env.NO_COLOR;
  const args = [
    'fork',
    'tapes/trip.tape',
    '--at',
    '4',
    '--diff',
    '--',
    'python',
    'agent_v2.py',
  ];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'dist/cli.js'), ...args],
      { cwd, env },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`Fork capture failed (${code}): ${output}`)),
    );
  });
  if (
    !output.includes('3 calls + 2 tools from tape') ||
    !output.includes('behavior differs')
  )
    throw new Error('Fork capture is missing its summary or diff');
  await writeFile(
    path.join(root, 'docs/assets/fork.svg'),
    terminalSvg(output, `tapediff ${args.join(' ')}`),
  );
  process.stdout.write(
    'Generated docs/assets/fork.svg from CLI output (exit 0)\n',
  );
} finally {
  await mock.close();
  await rm(cwd, { recursive: true, force: true });
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

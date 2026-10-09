import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import spawn from 'cross-spawn';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const tempRoot = path.resolve(tmpdir());
const project = await mkdtemp(path.join(tempRoot, 'tapediff-package-'));
const env = {
  ...process.env,
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  OPENAI_BASE_URL: '',
  OPENAI_API_BASE: '',
  ANTHROPIC_BASE_URL: '',
  TAPEDIFF_OPENAI_UPSTREAM: 'http://127.0.0.1:1',
  TAPEDIFF_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:1',
  TAPEDIFF_REDACT: '',
  TAPEDIFF_TAPE: '',
  TAPEDIFF_PROXY_URL: '',
  NO_COLOR: '1',
};
delete env.FORCE_COLOR;

function run(command, args, cwd = project) {
  const result = spawn.sync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

try {
  const [pack] = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', project], root).stdout,
  );
  for (const file of pack.files) {
    assert.match(
      file.path,
      /^(?:dist\/(?:[^/]+\.js|tools\/index\.(?:js|cjs|d\.ts|d\.cts))|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
    );
    assert.doesNotMatch(
      file.path,
      /test|fixture|example|coverage|clients|\.tape/i,
    );
  }
  process.stdout.write(
    `Package: ${pack.filename}\nPacked: ${pack.size} bytes; unpacked: ${pack.unpackedSize} bytes\n${pack.files.map((file) => file.path).join('\n')}\n`,
  );
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  const example = path.join(root, 'examples/ts-anthropic');
  const sdk = JSON.parse(
    await readFile(path.join(example, 'package.json'), 'utf8'),
  ).dependencies['@anthropic-ai/sdk'];
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    path.join(project, pack.filename),
    `@anthropic-ai/sdk@${sdk}`,
  ]);
  for (const [flag, source] of [
    [
      '--input-type=module',
      `import { tool, wrapTool, TapediffToolMissError } from 'tapediff/tools'; if (await tool('x', 2, n => n + 1) !== 3 || await wrapTool('x', n => n)(4) !== 4 || !TapediffToolMissError) throw Error('tools');`,
    ],
    [
      '--input-type=commonjs',
      `const { tool, wrapTool, TapediffToolMissError } = require('tapediff/tools'); tool('x', 2, n => n + 1).then(n => { if (n !== 3 || !wrapTool || !TapediffToolMissError) throw Error('tools'); });`,
    ],
  ])
    run('node', [flag, '-e', source]);
  for (const file of ['types.mts', 'types.cts'])
    await writeFile(
      path.join(project, file),
      `import { tool, wrapTool } from 'tapediff/tools'; const a: Promise<number> = tool('x', { n: 1 }, args => args.n); const b: Promise<string> = wrapTool('x', async (args: { s: string }) => args.s)({ s: 'a' }); void a; void b;`,
    );
  run('node', [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--module',
    'NodeNext',
    '--target',
    'ES2022',
    'types.mts',
    'types.cts',
  ]);
  for (const file of ['agent.mjs', 'tapes/paris.tape'])
    await copyFile(
      path.join(example, file),
      path.join(project, path.basename(file)),
    );
  const version = run('npx', ['--no-install', 'tapediff', '--version']);
  assert.equal(version.stdout.trim(), manifest.version);
  assert.match(
    run('npx', ['--no-install', 'tapediff', '--help']).stdout,
    /Usage: tapediff/,
  );
  const replay = run('npx', [
    '--no-install',
    'tapediff',
    'replay',
    'paris.tape',
    '--',
    'node',
    'agent.mjs',
  ]);
  assert.match(replay.stdout, /Paris: sunny, 22 C\. Your 100 USD is 92 EUR\./);
  assert.match(replay.stderr, /0 misses/);
  assert.doesNotMatch(replay.stderr, /never requested/);
  if (process.platform === 'win32') {
    const shim = path.join(project, 'node_modules/.bin/tapediff.cmd');
    assert.equal(run(shim, ['--version']).stdout.trim(), manifest.version);
    assert.match(run(shim, ['--help']).stdout, /Usage: tapediff/);
    assert.match(
      run(shim, ['replay', 'paris.tape', '--', 'node', 'agent.mjs']).stdout,
      /Paris: sunny/,
    );
    process.stdout.write(
      'Windows tapediff.cmd: version, help, replay all exited 0.\n',
    );
  }
  process.stdout.write(
    'Installed tarball: ESM/CJS tools, TypeScript declarations, npx version, help, offline Node replay all passed.\n',
  );
} finally {
  assert.equal(path.dirname(path.resolve(project)), tempRoot);
  assert.ok(path.basename(project).startsWith('tapediff-package-'));
  await rm(project, { recursive: true, force: true });
}

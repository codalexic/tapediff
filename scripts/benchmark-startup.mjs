import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import spawn from 'cross-spawn';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const times = [];
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  const result = spawn.sync(process.execPath, ['dist/cli.js', '--version'], {
    cwd: root,
    encoding: 'utf8',
  });
  times.push(performance.now() - start);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
}
const sorted = [...times].sort((a, b) => a - b);
const traced = spawn.sync(process.execPath, ['dist/cli.js', '--version'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, NODE_DEBUG: 'esm,module' },
});
assert.ifError(traced.error);
assert.equal(traced.status, 0);
assert.match(traced.stderr, /cli\.js/);
assert.doesNotMatch(traced.stderr, /node_modules[\\/](?:react|ink)[\\/]/i);
assert.doesNotMatch(traced.stderr, /export-[\w-]+\.js/);
process.stdout.write(
  `${process.platform} ${process.arch}, Node ${process.version}\n10 fresh processes (ms): ${times.map((n) => n.toFixed(2)).join(', ')}\nMedian: ${((sorted[4] + sorted[5]) / 2).toFixed(2)} ms\nESM/CommonJS trace: React, Ink and export not loaded.\n`,
);

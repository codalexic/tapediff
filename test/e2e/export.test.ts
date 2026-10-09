import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { run } from '../helpers/cli.js';
import { readTape } from '../../src/tape/io.js';
import { toOtlp } from '../../src/export/otlp.js';

const tape = fileURLToPath(
  new URL('../fixtures/steps/chat-json.tape', import.meta.url),
);
const directories: string[] = [];
const servers: Server[] = [];
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-export-'));
  directories.push(dir);
  return dir;
}
async function receiver(status = 200, hang = false) {
  const requests: {
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
    method: string;
  }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        url: req.url!,
        headers: req.headers,
        body,
        method: req.method!,
      });
      if (hang) return;
      res.writeHead(status, {
        'content-type': 'application/json',
        location: '/redirect-target',
      });
      res.end('{"message":"private-server-error"}');
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of directories.splice(0)) {
    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('exports exact JSON to stdout by default and honors format, service and content options', async () => {
  const data = await readTape(tape);
  for (const args of [
    [],
    ['--format', 'otlp-json', '--include-content', '--service-name', 'demo'],
  ]) {
    const result = await run(['export', tape, ...args]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${JSON.stringify(toOtlp(data, args.length ? { includeContent: true, serviceName: 'demo' } : {}))}\n`,
    );
  }
});

it('writes a file, refuses overwrite, and replaces with --force including a nonexistent target', async () => {
  const out = path.join(await directory(), 'traces.json');
  const first = await run(['export', tape, '--out', out, '--force']);
  expect(first).toEqual({ code: 0, stdout: '', stderr: '' });
  const content = await readFile(out, 'utf8');
  expect(content).toBe((await run(['export', tape])).stdout);
  const second = await run(['export', tape, '--out', out]);
  expect(second.code).toBe(2);
  expect(second.stderr).toContain('use --force');
  expect(await readFile(out, 'utf8')).toBe(content);
  await writeFile(out, 'old');
  expect((await run(['export', tape, '--out', out, '--force'])).code).toBe(0);
  expect(await readFile(out, 'utf8')).toBe(content);
});

it('handles file creation and replacement failures with safe usage errors', async () => {
  const dir = await directory();
  const out = path.join(dir, 'directory');
  await mkdir(out);
  const missing = await run([
    'export',
    tape,
    '--out',
    path.join(dir, 'missing', 'file'),
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toBe('error: cannot create export file\n');
  const replace = await run(['export', tape, '--out', out, '--force']);
  expect(replace.code).toBe(2);
  expect(replace.stderr).toBe('error: cannot replace export file\n');
});

it('replaces a symlink itself without truncating its target', async ({
  skip,
}) => {
  if (process.platform === 'win32') {
    const reason =
      'Windows symlinks require Developer Mode or elevated privileges; this test runs on Linux and macOS.';
    console.info(`Skipping symlink replacement test: ${reason}`);
    skip(reason);
  }
  const dir = await directory();
  const target = path.join(dir, 'target');
  const out = path.join(dir, 'link');
  await writeFile(target, 'keep');
  await symlink(target, out);
  expect((await run(['export', tape, '--out', out, '--force'])).code).toBe(0);
  expect(await readFile(target, 'utf8')).toBe('keep');
});

it.each([200, 201, 202, 204, 299])(
  'POST accepts HTTP %i and sends the OTLP path, auth headers and body',
  async (status) => {
    const server = await receiver(status);
    const result = await run(['export', tape, '--endpoint', server.url], {
      OTEL_EXPORTER_OTLP_HEADERS:
        'authorization=Bearer%20private-auth,x-project=project=one, content-type=text/plain',
    });
    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      url: '/v1/traces',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer private-auth',
        'x-project': 'project=one',
      },
    });
    expect(server.requests[0]!.body).toBe(
      `${JSON.stringify(toOtlp(await readTape(tape)))}\n`,
    );
  },
);

it('preserves explicit endpoint paths and query strings and can send and save together', async () => {
  const server = await receiver();
  const out = path.join(await directory(), 'traces.json');
  const result = await run(
    [
      'export',
      tape,
      '--endpoint',
      `${server.url}/custom/traces?tenant=one`,
      '--out',
      out,
    ],
    { OTEL_EXPORTER_OTLP_HEADERS: '' },
  );
  expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
  expect(server.requests[0]!.url).toBe('/custom/traces?tenant=one');
  expect(server.requests[0]!.body).toBe(await readFile(out, 'utf8'));
});

it('does not send when the output file already exists', async () => {
  const server = await receiver();
  const out = path.join(await directory(), 'traces.json');
  await writeFile(out, 'keep');
  expect(
    (await run(['export', tape, '--endpoint', server.url, '--out', out])).code,
  ).toBe(2);
  expect(server.requests).toHaveLength(0);
});

it.each([301, 400, 401, 500])(
  'fails safely with HTTP %i without following redirects or echoing secrets',
  async (status) => {
    const server = await receiver(status);
    const out = path.join(await directory(), 'traces.json');
    const result = await run(
      [
        '--verbose',
        'export',
        tape,
        '--endpoint',
        `${server.url}?key=private-url`,
        '--out',
        out,
      ],
      { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer private-auth' },
    );
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `error: OTLP export failed (HTTP ${status})\n`,
    });
    expect(server.requests).toHaveLength(1);
    expect(await readFile(out, 'utf8')).toBe(server.requests[0]!.body);
  },
);

it('times out after ten seconds without printing credentials', async () => {
  const server = await receiver(200, true);
  const start = Date.now();
  const result = await run(['export', tape, '--endpoint', server.url], {
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=private-auth',
  });
  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr: 'error: OTLP export failed (connection or timeout)\n',
  });
  expect(Date.now() - start).toBeGreaterThanOrEqual(9900);
});

it('reports connection failure as exit 1', async () => {
  const server = await receiver();
  const active = servers.pop()!;
  await new Promise<void>((resolve) => active.close(() => resolve()));
  const result = await run(['export', tape, '--endpoint', server.url]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(
    'error: OTLP export failed (connection or timeout)\n',
  );
});

it.each([
  [],
  [tape, '--format', 'xml'],
  [tape, '--unknown'],
  [tape, '--endpoint', 'invalid'],
  [tape, '--endpoint', 'file:///private'],
  [tape, '--endpoint', 'http://user:private@localhost'],
  [tape, '--endpoint', 'http://localhost#private'],
  [`${tape}.missing`],
])('returns exit 2 on usage errors: %j', async (...args: string[]) => {
  const result = await run(['export', ...args]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('private');
});

it.each([
  'private-header',
  '=private',
  'authorization=%XXprivate',
  'x-header=private%0Ainjection',
])('rejects invalid headers safely: %s', async (headers) => {
  const result = await run(
    ['export', tape, '--endpoint', 'http://localhost:4318'],
    { OTEL_EXPORTER_OTLP_HEADERS: headers },
  );
  expect(result).toEqual({
    code: 2,
    stdout: '',
    stderr: 'error: invalid OTLP export headers\n',
  });
});

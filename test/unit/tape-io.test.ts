import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTape, TapeWriter } from '../../src/tape/io.js';
import { exchange, fixturePath, fixtureText, header } from './tape-fixtures.js';

let directory: string;
let tapePath: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tapediff-tape-'));
  tapePath = path.join(directory, 'test.tape');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('tape IO', () => {
  it('writes and reads a header and exchange, including before the writer closes', async () => {
    const writer = await TapeWriter.open(tapePath, header);
    try {
      expect(await readTape(tapePath)).toEqual({ header, exchanges: [] });
      await writer.appendExchange(exchange);
      expect(await readTape(tapePath)).toEqual({
        header,
        exchanges: [exchange],
      });
    } finally {
      await writer.close();
    }
    const raw = await readFile(tapePath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n')).toHaveLength(3);
    expect(await readTape(tapePath)).toEqual({ header, exchanges: [exchange] });
    await writer.close();
    await expect(writer.appendExchange(exchange)).rejects.toThrow(
      'tape writer is closed',
    );
  });

  it('serializes concurrent appends and close waits for them; snapshots caller data', async () => {
    const writer = await TapeWriter.open(tapePath, header);
    const first = structuredClone(exchange);
    const writes = [writer.appendExchange(first)];
    first.id = 999;
    for (let id = 1; id < 40; id++)
      writes.push(writer.appendExchange({ ...exchange, id, seq: id }));
    await Promise.all([...writes, writer.close()]);
    expect(
      (await readTape(tapePath)).exchanges.map((entry) => entry.id),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index));
  });

  it('refuses to overwrite an existing tape', async () => {
    await writeFile(tapePath, fixtureText);
    await expect(TapeWriter.open(tapePath, header)).rejects.toThrow();
    expect(await readFile(tapePath, 'utf8')).toBe(fixtureText);
  });

  it('redacts headers, body, command, and split SSE secrets before persisting', async () => {
    vi.stubEnv('TAPEDIFF_REDACT', 'custom-[a-z]+');
    const secret = 'sk-ant-api03-fake0123456789abcdefgh';
    const writer = await TapeWriter.open(tapePath, {
      ...header,
      command: ['node', secret],
      name: 'structural-name',
    });
    try {
      await writer.appendExchange({
        ...exchange,
        request: {
          ...exchange.request,
          headers: {
            authorization: 'Bearer xyz',
            'x-api-key': secret,
            'x-request-id': 'custom-sensitive',
          },
          body: { secret, extra: 'custom-sensitive' },
        },
        response: {
          status: 200,
          headers: {
            'set-cookie': secret,
            'content-type': 'text/event-stream',
          },
          sse: [
            { t: 0, data: secret.slice(0, 7) },
            { t: 10, data: secret.slice(7) },
          ],
        },
      });
    } finally {
      await writer.close();
    }
    const raw = await readFile(tapePath, 'utf8');
    for (const value of [
      secret,
      'Bearer xyz',
      'custom-sensitive',
      'authorization',
      'x-api-key',
      'set-cookie',
    ])
      expect(raw).not.toContain(value);
    const tape = await readTape(tapePath);
    expect(tape.header.command).toEqual(['node', '[REDACTED]']);
    expect(tape.exchanges[0]?.request.headers).toEqual({
      'x-request-id': '[REDACTED]',
    });
    expect(
      tape.exchanges[0]?.response.sse?.map((chunk) => chunk.data).join(''),
    ).toBe('[REDACTED]');
  });

  it('rejects invalid input before appending and keeps the writer usable', async () => {
    const writer = await TapeWriter.open(tapePath, header);
    try {
      await expect(
        writer.appendExchange({ ...exchange, id: -1 }),
      ).rejects.toThrow('cannot append invalid tape exchange');
      await writer.appendExchange(exchange);
    } finally {
      await writer.close();
    }
    expect((await readTape(tapePath)).exchanges).toEqual([exchange]);
    await expect(
      TapeWriter.open(path.join(directory, 'invalid.tape'), {
        ...header,
        createdAt: 'bad',
      }),
    ).rejects.toThrow('tape line 1');
  });

  it.each(['{"id":', '{"id":1,"request":{"body":"cut', '{"id":1.', '{"id":1e'])(
    'ignores a truncated final exchange with a line-numbered warning: %s',
    async (tail) => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      await writeFile(tapePath, `${fixtureText.trimEnd()}\n${tail}`);
      expect(await readTape(tapePath)).toEqual({
        header,
        exchanges: [exchange],
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'tape line 3: ignoring truncated final line',
      );
    },
  );

  it('accepts CRLF and a complete final record without a trailing newline', async () => {
    for (const text of [
      fixtureText.trimEnd(),
      `${fixtureText.trimEnd()}\n`.replace(/\r?\n/g, '\r\n'),
    ]) {
      await writeFile(tapePath, text);
      expect(await readTape(tapePath)).toEqual({
        header,
        exchanges: [exchange],
      });
    }
  });

  it('reads the checked-in streaming fixture', async () => {
    const tape = await readTape(fixturePath('streaming'));
    expect(tape.exchanges[0]?.response.sse).toHaveLength(2);
  });

  it.each([
    ['{"id":\n', 3], // newline-terminated incomplete JSON is corruption
    ['{"id":wat', 3], // invalid token is corruption, even at EOF
    ['{}', 3], // complete but schema-invalid records are never ignored
    ['\n{}', 3], // blank middle line
    ['{"id":\n{}', 3], // truncated middle line
  ])('rejects corrupt records: %j', async (tail, line) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(tapePath, `${fixtureText.trimEnd()}\n${tail}`);
    await expect(readTape(tapePath)).rejects.toThrow(`tape line ${line}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects missing, empty, truncated-header, and future-version tapes', async () => {
    await expect(readTape(tapePath)).rejects.toThrow();
    for (const text of [
      '',
      '{"tapediff":',
      JSON.stringify({ ...header, tapediff: 2 }),
    ]) {
      await writeFile(tapePath, text);
      await expect(readTape(tapePath)).rejects.toThrow('tape line 1');
    }
  });
});

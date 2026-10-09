import { unlink, writeFile } from 'node:fs/promises';
import { readTapeOrFail } from '../tape/read-or-fail.js';
import { toOtlp, type ExportOptions } from '../export/otlp.js';

export interface ExportCommandOptions extends ExportOptions {
  format?: 'otlp-json';
  out?: string;
  endpoint?: string;
  force?: boolean;
}

function destination(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    if (url.pathname === '/') url.pathname = '/v1/traces';
    return url;
  } catch {
    throw new Error('invalid export endpoint');
  }
}

function exportHeaders(value: string | undefined): Headers {
  try {
    const headers = new Headers();
    for (const entry of value?.split(',') ?? []) {
      if (!entry.trim()) continue;
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error();
      headers.set(
        entry.slice(0, separator).trim(),
        decodeURIComponent(entry.slice(separator + 1).trim()),
      );
    }
    headers.set('content-type', 'application/json');
    return headers;
  } catch {
    throw new Error('invalid OTLP export headers');
  }
}

export async function exportCommand(
  tape: string,
  options: ExportCommandOptions,
): Promise<number> {
  const endpoint =
    options.endpoint === undefined ? undefined : destination(options.endpoint);
  const headers = endpoint
    ? exportHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    : undefined;
  const body = `${JSON.stringify(toOtlp(await readTapeOrFail(tape), options))}\n`;
  if (options.out !== undefined) {
    if (options.force) {
      try {
        await unlink(options.out);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw new Error('cannot replace export file', { cause: error });
      }
    }
    try {
      await writeFile(options.out, body, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new Error('output file exists; use --force to overwrite', {
          cause: error,
        });
      throw new Error('cannot create export file', { cause: error });
    }
  }
  if (endpoint) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      await response.body?.cancel();
      if (!response.ok) {
        process.stderr.write(
          `error: OTLP export failed (HTTP ${response.status})\n`,
        );
        return 1;
      }
    } catch {
      process.stderr.write(
        'error: OTLP export failed (connection or timeout)\n',
      );
      return 1;
    }
  } else if (options.out === undefined) process.stdout.write(body);
  return 0;
}

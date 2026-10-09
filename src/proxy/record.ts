import { createToolHandler, isToolRoute } from './tools.js';
import { once } from 'node:events';
import { request as upstreamRequest } from 'undici';
import type { Dispatcher } from 'undici';
import { extractOpenAI } from '../providers/openai.js';
import { extractAnthropic } from '../providers/anthropic.js';
import { costUsd } from '../providers/pricing.js';
import { modelOf, type Metadata } from '../providers/usage.js';
import { matchKey, normalizePath } from '../tape/normalize.js';
import { redactHeaders } from '../tape/redact.js';
import type { TapeWriter } from '../tape/io.js';
import type { Exchange, JsonValue, SseChunk } from '../tape/schema.js';
import type { ProxyContext, ProxyHandler } from './server.js';
import { SseParser } from './sse.js';
import { parseBody, readRequestBody } from './body.js';

/** Transport headers are independent of the tape's stricter header allowlist. */
export function forwardingHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const blocked = new Set([
    'connection',
    'transfer-encoding',
    'keep-alive',
    'content-length',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    'host',
  ]);
  const connection = headers.connection;
  for (const name of (Array.isArray(connection)
    ? connection.join(',')
    : (connection ?? '')
  ).split(','))
    blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] =>
        entry[1] !== undefined && !blocked.has(entry[0].toLowerCase()),
    ),
  );
}

export function createRecordHandler(
  writer: Pick<TapeWriter, 'appendExchange'> &
    Partial<Pick<TapeWriter, 'appendTool'>>,
  onExchange?: (exchange: Exchange) => void,
): ((
  context: ProxyContext,
  incoming?: Awaited<ReturnType<typeof readRequestBody>>,
) => Promise<void>) &
  Pick<ProxyHandler, 'close'> {
  const tools = createToolHandler({
    mode: 'record',
    writer: writer.appendTool
      ? { appendTool: writer.appendTool.bind(writer) }
      : undefined,
  });
  const record = async (
    context: ProxyContext,
    incoming?: Awaited<ReturnType<typeof readRequestBody>>,
  ) => {
    if (isToolRoute(context.path)) return tools.handler(context);
    const {
      request,
      response,
      provider,
      path,
      upstream,
      seq,
      startedAt,
      started,
      signal,
    } = context;
    let body: JsonValue = null;
    let recorded: Exchange['response'] = { status: 502, headers: {} };
    let metadata: Metadata = {};
    const sse: SseChunk[] = [];
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let streaming = false;
    let responseStart = 0;
    let responseText = '';
    const extract =
      provider === 'openai'
        ? extractOpenAI
        : provider === 'anthropic'
          ? extractAnthropic
          : (_value: unknown, previous: Metadata) => previous;
    const collect = (text: string, final = false) => {
      if (streaming) {
        if (text)
          sse.push({
            t: Math.max(0, performance.now() - responseStart),
            data: text,
          });
        for (const frame of parser.push(text, final)) {
          try {
            metadata = extract(JSON.parse(frame.data) as unknown, metadata);
          } catch {
            /* Comments, [DONE], and non-JSON events. */
          }
        }
      } else responseText += text;
    };
    try {
      incoming ??= await readRequestBody(request);
      const { bytes } = incoming;
      body = incoming.body;
      metadata.model = modelOf(body);
      if (!upstream) {
        recorded = {
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: {
            error: { message: 'use /openai/ or /anthropic/ proxy routes' },
          },
        };
        response.writeHead(recorded.status, recorded.headers);
        response.end(JSON.stringify(recorded.body));
      } else {
        const headers = forwardingHeaders(request.headers);
        headers['accept-encoding'] = 'identity';
        const result = await upstreamRequest(upstream, {
          method: (request.method ?? 'GET') as Dispatcher.HttpMethod,
          headers,
          body: bytes.length ? bytes : undefined,
          signal,
          // Long-lived agent streams may legitimately pause for many minutes.
          bodyTimeout: 0,
          headersTimeout: 300_000,
          maxRedirections: 0,
        });
        responseStart = performance.now();
        streaming = /^text\/event-stream(?:\s*;|$)/i.test(
          String(result.headers['content-type'] ?? ''),
        );
        recorded = {
          status: result.statusCode,
          headers: redactHeaders(result.headers),
          ...(streaming ? { sse } : {}),
        };
        response.writeHead(
          result.statusCode,
          forwardingHeaders(result.headers),
        );
        response.flushHeaders();
        for await (const chunk of result.body) {
          // Forward the original bytes before parsing or storing anything.
          const writable = response.write(chunk);
          collect(decoder.decode(chunk as Uint8Array, { stream: true }));
          if (!writable) await once(response, 'drain', { signal });
        }
        collect(decoder.decode(), true);
        if (!streaming) {
          if (responseText !== '')
            recorded.body = /\bjson\b/i.test(
              String(result.headers['content-type'] ?? ''),
            )
              ? parseBody(responseText)
              : responseText;
          metadata = extract(recorded.body, metadata);
        }
        response.end();
      }
    } catch {
      // Native network errors may contain upstream URLs/credentials; use a fixed message.
      const error = {
        error: {
          message: signal.aborted
            ? 'request aborted'
            : 'upstream network error',
        },
      };
      if (!response.headersSent) {
        recorded = {
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: error,
        };
        if (!response.destroyed) {
          response.writeHead(502, recorded.headers);
          response.end(JSON.stringify(error));
        }
      } else {
        recorded.body = error;
        response.destroy();
      }
      if (streaming) collect(decoder.decode(), true);
    }
    const exchange: Exchange = {
      id: seq,
      seq,
      provider,
      endpoint: normalizePath(path),
      request: {
        method: request.method ?? 'GET',
        path,
        headers: redactHeaders(request.headers),
        body,
      },
      matchKey: matchKey(request.method ?? 'GET', path, body),
      looseKey: matchKey(request.method ?? 'GET', path, body, 'loose'),
      response: recorded,
      timing: {
        startedAt,
        latencyMs: Math.max(0, performance.now() - started),
      },
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      costUsd: costUsd(metadata.model, metadata.usage, provider),
      ...(signal.aborted ? { aborted: true } : {}),
    };
    await writer.appendExchange(exchange);
    onExchange?.(exchange);
  };
  return Object.assign(record, { close: () => tools.close() });
}

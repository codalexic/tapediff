import type { TapeWriter } from '../tape/io.js';
import { matchKey, normalizePath } from '../tape/normalize.js';
import { redactHeaders } from '../tape/redact.js';
import type { Exchange } from '../tape/schema.js';
import { readRequestBody } from './body.js';
import { createForkMatcher } from './fork-match.js';
import { createRecordHandler } from './record.js';
import { serveRecordedResponse, type ReplayOptions } from './replay.js';
import type { ProxyHandler } from './server.js';

export interface ForkOptions {
  at?: number;
  pace?: ReplayOptions['pace'];
}

export function createForkHandler(
  exchanges: readonly Exchange[],
  writer: Pick<TapeWriter, 'appendExchange'>,
  options: ForkOptions = {},
  onExchange?: (exchange: Exchange) => void,
  warn?: (message: string) => void,
) {
  const matcher = createForkMatcher(exchanges, options.at, warn);
  const record = createRecordHandler(writer, onExchange);
  let pending = Promise.resolve();
  const handler: ProxyHandler = async (context) => {
    const { request, path, provider, seq, startedAt, response, signal } =
      context;
    // Reserve in arrival order; only selection waits, never upstream or SSE delivery.
    const body = readRequestBody(request).then(
      (incoming) => ({ incoming }),
      (error: unknown) => ({ error }),
    );
    const selection = pending.then(async () => {
      const result = await body;
      if ('error' in result) throw result.error;
      const method = request.method ?? 'GET';
      const exchange = matcher.take(provider, {
        method,
        path,
        body: result.incoming.body,
      });
      return { incoming: result.incoming, method, exchange };
    });
    pending = selection.then(
      () => {},
      () => {},
    );
    const { incoming, method, exchange } = await selection;
    if (!exchange) return record(context, incoming);
    const served: Exchange = {
      ...exchange,
      id: seq,
      seq,
      provider,
      endpoint: normalizePath(path),
      request: {
        method,
        path,
        headers: redactHeaders(request.headers),
        body: incoming.body,
      },
      matchKey: matchKey(method, path, incoming.body),
      looseKey: matchKey(method, path, incoming.body, 'loose'),
      timing: { startedAt, latencyMs: exchange.timing.latencyMs },
      servedFrom: { seq: exchange.seq },
    };
    await writer.appendExchange(served);
    onExchange?.(served);
    await serveRecordedResponse(
      exchange.response,
      response,
      signal,
      options.pace,
    );
  };
  return {
    handler,
    get stats() {
      return matcher.stats;
    },
  };
}

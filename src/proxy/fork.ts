import { createToolHandler } from './tools.js';
import type { TapeWriter } from '../tape/io.js';
import { matchKey, normalizePath } from '../tape/normalize.js';
import { redactHeaders } from '../tape/redact.js';
import type { Exchange } from '../tape/schema.js';
import { readRequestBody } from './body.js';
import { createForkMatcher } from './fork-match.js';
import { createExchangeRecorder } from './record.js';
import { serveRecordedResponse, type ReplayOptions } from './replay.js';
import type { ProxyHandler } from './server.js';

export interface ForkOptions {
  at?: number;
  pace?: ReplayOptions['pace'];
  tools?: ReplayOptions['tools'];
}

export function createForkHandler(
  exchanges: readonly Exchange[],
  writer: Pick<TapeWriter, 'appendExchange'> &
    Partial<Pick<TapeWriter, 'appendTool'>>,
  options: ForkOptions = {},
  onExchange?: (exchange: Exchange) => void,
  warn?: (message: string) => void,
) {
  const matcher = createForkMatcher(exchanges, options.at, warn);
  const tools = createToolHandler({
    mode: 'fork',
    tools: options.tools,
    writer: writer.appendTool
      ? { appendTool: writer.appendTool.bind(writer) }
      : undefined,
    isLive: () => matcher.stats.live,
    diverge: (name) => matcher.divergeTool(name),
    warn,
  });
  const record = createExchangeRecorder(writer, onExchange);
  let pending = Promise.resolve();
  const handler: ProxyHandler = async (context) => {
    if (context.reserved) {
      const selection = pending.then(() => tools.handler(context));
      pending = selection.catch(() => {});
      return selection;
    }
    const { request, path, provider, seq, startedAt, response, signal } =
      context;
    // Reserve in arrival order; only selection waits, never upstream or SSE delivery.
    const body = readRequestBody(request).then(
      (incoming) => ({ incoming }),
      (error: unknown) => ({ error }),
    );
    const selection = pending.then(async () => {
      const result = await body;
      if ('error' in result) return result;
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
    const selected = await selection;
    if ('error' in selected) return record(context, undefined, selected);
    const { incoming, method, exchange } = selected;
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
  handler.close = () => tools.close();
  return {
    handler,
    get stats() {
      return {
        ...matcher.stats,
        tools: tools.stats.consumed,
        liveTools: tools.stats.recorded,
        unconsumed: matcher.stats.unconsumed + tools.stats.unconsumed,
      };
    },
  };
}

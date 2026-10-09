import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { detectProvider } from '../providers/detect.js';
import { normalizePath } from '../tape/normalize.js';
import type { Provider } from '../tape/schema.js';

export interface ProxyContext {
  request: IncomingMessage;
  response: ServerResponse;
  provider: Provider;
  path: string;
  upstream?: URL;
  seq: number;
  startedAt: string;
  started: number;
  signal: AbortSignal;
}
export type ProxyHandler = (context: ProxyContext) => Promise<void>;

export function resolveUpstreams(env: NodeJS.ProcessEnv) {
  return {
    openai:
      env.TAPEDIFF_OPENAI_UPSTREAM ||
      env.OPENAI_BASE_URL ||
      env.OPENAI_API_BASE ||
      'https://api.openai.com',
    anthropic:
      env.TAPEDIFF_ANTHROPIC_UPSTREAM ||
      env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com',
  };
}

/** OpenAI bases include the API prefix; Anthropic SDK routes include /v1. */
export function upstreamUrl(
  base: string,
  path: string,
  provider: Provider = 'openai',
): URL {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('upstream must use HTTP or HTTPS');
  const query = path.indexOf('?');
  let pathname = query < 0 ? path : path.slice(0, query);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (provider === 'openai' && basePath && /^\/v1(?:\/|$)/.test(pathname))
    pathname = pathname.slice(3);
  url.pathname = `${basePath}${pathname}` || '/';
  if (query >= 0) {
    // Preserve gateway query parameters as well as request parameters.
    const params = new URLSearchParams(path.slice(query + 1));
    for (const [key, value] of params) url.searchParams.append(key, value);
  }
  return url;
}

export async function createProxy(options: {
  mode: 'record' | 'replay' | 'fork';
  handler: ProxyHandler;
  env?: NodeJS.ProcessEnv;
}) {
  // Capture once, before the caller builds the child's proxy environment.
  const upstreams = resolveUpstreams(options.env ?? process.env);
  if (options.mode !== 'replay') {
    for (const base of Object.values(upstreams)) upstreamUrl(base, '/');
  }
  const active = new Map<Promise<void>, AbortController>();
  let seq = 0;
  let failure: unknown;
  const server = createServer((request, response) => {
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', abort);
    request.once('aborted', abort);
    const route = request.url ?? '/';
    const provider = detectProvider(route);
    const path =
      normalizePath(route) +
      (route.includes('?') ? route.slice(route.indexOf('?')) : '');
    const context: ProxyContext = {
      request,
      response,
      provider,
      path,
      seq: seq++,
      startedAt: new Date().toISOString(),
      started: performance.now(),
      signal: controller.signal,
      upstream:
        options.mode !== 'replay' && provider !== 'unknown'
          ? upstreamUrl(upstreams[provider], path, provider)
          : undefined,
    };
    const task = Promise.resolve()
      .then(() => options.handler(context))
      .catch((error: unknown) => {
        failure ??= error;
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"error":{"message":"proxy handler failed"}}');
        } else response.destroy();
      })
      .finally(() => {
        active.delete(task);
        response.off('close', abort);
        request.off('aborted', abort);
      });
    active.set(task, controller);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('proxy did not bind TCP');
  const port = address.port;
  let closing: Promise<void> | undefined;
  return {
    port,
    baseUrls: {
      openai: `http://127.0.0.1:${port}/openai/v1`,
      anthropic: `http://127.0.0.1:${port}/anthropic`,
    },
    close(timeoutMs = 5_000): Promise<void> {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all([...active.keys()]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        for (const controller of active.values()) controller.abort();
        server.closeAllConnections();
        await Promise.all([...active.keys()]);
        await closed;
        if (failure)
          throw new Error('failed to handle an exchange', { cause: failure });
      })();
      return closing;
    },
  };
}

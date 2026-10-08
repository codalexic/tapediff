import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createTwoFilesPatch } from 'diff';
import { modelOf } from '../providers/usage.js';
import { readTapeOrFail } from '../tape/read-or-fail.js';
import {
  canonicalJson,
  matchKey,
  normalizePath,
  normalizeRequest,
} from '../tape/normalize.js';
import type { MatchMode } from '../tape/normalize.js';
import {
  parseRedactPatterns,
  redactBody,
  redactHeaders,
} from '../tape/redact.js';
import type { Exchange, JsonValue } from '../tape/schema.js';
import { readRequestBody } from './body.js';
import type { ProxyHandler } from './server.js';

export interface ReplayOptions {
  loose?: boolean;
  pace?: 'instant' | 'recorded';
}

type Request = Pick<Exchange['request'], 'method' | 'path' | 'body'>;

function prettyRequest(request: Request, mode: MatchMode): string {
  const clean = redactBody(
    normalizeRequest(request.method, request.path, request.body, mode),
    parseRedactPatterns(process.env.TAPEDIFF_REDACT),
  );
  return `${JSON.stringify(JSON.parse(canonicalJson(clean)) as JsonValue, null, 2)}\n`;
}

/** Shared canonical lines; ties retain recorded order. Only compare unused calls. */
export function replayMissDiff(
  request: Request,
  candidates: readonly Exchange[],
  mode: MatchMode = 'strict',
): string {
  const actual = prettyRequest(request, mode);
  const lines = new Set(actual.split('\n'));
  let nearest: string | undefined;
  let best = -1;
  for (const exchange of candidates) {
    if (exchange.endpoint !== normalizePath(request.path)) continue;
    const expected = prettyRequest(exchange.request, mode);
    const shared = [...new Set(expected.split('\n'))].filter((line) =>
      lines.has(line),
    ).length;
    if (shared > best) {
      best = shared;
      nearest = expected;
    }
  }
  return nearest === undefined
    ? `No unconsumed recorded request for this endpoint.\nIncoming request:\n${actual}`
    : createTwoFilesPatch(
        'recorded request',
        'incoming request',
        nearest,
        actual,
      );
}

/** Queues share consumption state so exact, seed-insensitive and fallback lookups cannot reuse a call. */
export function createReplayHandler(
  exchanges: readonly Exchange[],
  options: ReplayOptions = {},
  warn: (message: string) => void = (message) => process.stderr.write(message),
) {
  const ordered = [...exchanges].sort((a, b) => a.seq - b.seq);
  const consumed = new Set<Exchange>();
  const strict = new Map<string, Exchange[]>();
  const loose = new Map<string, Exchange[]>();
  for (const exchange of ordered) {
    const { method, path, body } = exchange.request;
    for (const [queue, key] of [
      [strict, exchange.matchKey],
      [loose, exchange.looseKey ?? matchKey(method, path, body, 'loose')],
    ] as const) {
      const entries = queue.get(key) ?? [];
      entries.push(exchange);
      queue.set(key, entries);
    }
  }
  let misses = 0;
  let fallbacks = 0;
  let requests = 0;
  const unused = () => ordered.filter((exchange) => !consumed.has(exchange));
  const take = (queue: Map<string, Exchange[]>, key: string) => {
    const entries = queue.get(key);
    while (entries?.length) {
      const exchange = entries.shift()!;
      if (!consumed.has(exchange)) return exchange;
    }
    return undefined;
  };
  const handler: ProxyHandler = async ({ request, response, path, signal }) => {
    try {
      const { body } = await readRequestBody(request);
      const method = request.method ?? 'GET';
      requests++;
      const mode = options.loose ? 'loose' : 'strict';
      let exchange = take(
        options.loose ? loose : strict,
        matchKey(method, path, body, mode),
      );
      if (!exchange && options.loose) {
        exchange = unused().find(
          (candidate) =>
            candidate.endpoint === normalizePath(path) &&
            modelOf(candidate.request.body) === modelOf(body),
        );
        if (exchange) {
          fallbacks++;
          warn(
            `warning: replay miss; loose fallback to recorded call ${exchange.seq} for ${redactBody(normalizePath(path), parseRedactPatterns(process.env.TAPEDIFF_REDACT)) as string}\n`,
          );
        }
      }
      if (!exchange) {
        misses++;
        const message = `No recorded match for ${method} ${normalizePath(path)}`;
        const safeMessage = redactBody(
          message,
          parseRedactPatterns(process.env.TAPEDIFF_REDACT),
        ) as string;
        warn(
          `replay miss: ${safeMessage}\n${replayMissDiff({ method, path, body }, unused(), options.loose ? 'loose' : 'strict')}`,
        );
        response.writeHead(500, {
          'content-type': 'application/json',
          'x-should-retry': 'false',
        });
        response.end(
          JSON.stringify({
            error: { type: 'tapediff_replay_miss', message: safeMessage },
          }),
        );
        return;
      }
      consumed.add(exchange);
      const recorded = exchange.response;
      const headers = redactHeaders(recorded.headers);
      if (recorded.sse) headers['content-type'] = 'text/event-stream';
      response.writeHead(recorded.status, headers);
      response.flushHeaders();
      if (recorded.sse) {
        response.socket?.setNoDelay(true);
        const started = performance.now();
        for (const chunk of recorded.sse) {
          if (options.pace === 'recorded') {
            const remaining = Math.ceil(
              chunk.t - (performance.now() - started),
            );
            if (remaining > 0) await delay(remaining, undefined, { signal });
          }
          signal.throwIfAborted();
          // Raw chunks retain SSE event names, data lines, comments and delimiters.
          if (!response.write(chunk.data))
            await once(response, 'drain', { signal });
        }
        response.end();
      } else {
        const body = recorded.body;
        response.end(
          body === undefined
            ? undefined
            : typeof body === 'string' &&
                !/\bjson\b/i.test(headers['content-type'] ?? '')
              ? body
              : JSON.stringify(body),
        );
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      response.destroy();
    }
  };
  return {
    handler,
    get stats() {
      return {
        requests,
        misses,
        fallbacks,
        consumed: consumed.size,
        unconsumed: unused().length,
      };
    },
  };
}

export async function loadReplay(tape: string, options: ReplayOptions = {}) {
  const data = await readTapeOrFail(tape);
  return createReplayHandler(data.exchanges, options);
}

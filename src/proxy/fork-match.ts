import { matchKey, normalizePath } from '../tape/normalize.js';
import { parseRedactPatterns, redactBody } from '../tape/redact.js';
import type { Exchange, Provider } from '../tape/schema.js';
import { replayMissDiff } from './replay.js';

export function createForkMatcher(
  exchanges: readonly Exchange[],
  at?: number,
  warn: (message: string) => void = (message) => process.stderr.write(message),
) {
  const ordered = [...exchanges].sort((a, b) => a.seq - b.seq);
  const calls = ordered.filter((exchange) => exchange.provider !== 'unknown');
  const consumed = new Set<Exchange>();
  const queues = new Map<string, Exchange[]>();
  for (const exchange of ordered) {
    const key = `${exchange.provider === 'unknown'}:${exchange.matchKey}`;
    const queue = queues.get(key) ?? [];
    queue.push(exchange);
    queues.set(key, queue);
  }
  let live = false;
  let position = 0;
  let changed = 0;
  const warning = (message: string) =>
    warn(
      redactBody(
        message,
        parseRedactPatterns(process.env.TAPEDIFF_REDACT),
      ) as string,
    );
  return {
    take(
      provider: Provider,
      request: Pick<Exchange['request'], 'method' | 'path' | 'body'>,
    ) {
      const known = provider !== 'unknown';
      if (known) position++;
      if (live && (known || at === undefined)) return undefined;
      const key = matchKey(request.method, request.path, request.body);
      let exchange: Exchange | undefined;
      if (at !== undefined && known) {
        if (position >= at) {
          live = true;
          return undefined;
        }
        exchange = calls[position - 1];
        if (!exchange) {
          warning(
            `fork: recorded calls exhausted at call #${position}, going live\n`,
          );
          live = true;
          return undefined;
        }
        const endpoint = normalizePath(request.path);
        if (normalizePath(exchange.endpoint) !== endpoint) {
          warning(
            `fork: call #${position} endpoint changed (${normalizePath(exchange.endpoint)} -> ${endpoint}), going live early\n`,
          );
          live = true;
          return undefined;
        }
        if (exchange.matchKey !== key) {
          changed++;
          warning(
            `fork: call #${position} served from tape although its request changed\n`,
          );
        }
      } else {
        exchange = queues.get(`${!known}:${key}`)?.shift();
        if (!exchange && known) {
          live = true;
          warning(
            `fork: diverged at call #${position} (${request.method} ${normalizePath(request.path)}), going live\n`,
          );
          warn(
            replayMissDiff(
              request,
              ordered.filter((candidate) => !consumed.has(candidate)),
            ),
          );
        }
      }
      if (exchange) consumed.add(exchange);
      return exchange;
    },
    get stats() {
      return {
        live,
        changed,
        unconsumed: calls.filter((call) => !consumed.has(call)).length,
      };
    },
  };
}

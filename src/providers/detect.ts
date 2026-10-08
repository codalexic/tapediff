import type { Provider } from '../tape/schema.js';

/** Detect explicit proxy routes first, then supported unprefixed API paths. */
export function detectProvider(path: string): Provider {
  const pathname = path.split('?')[0] ?? '';
  if (/^\/openai(?:\/|$)/.test(pathname)) return 'openai';
  if (/^\/anthropic(?:\/|$)/.test(pathname)) return 'anthropic';
  if (pathname === '/v1/chat/completions' || pathname === '/v1/responses')
    return 'openai';
  if (pathname === '/v1/messages') return 'anthropic';
  return 'unknown';
}

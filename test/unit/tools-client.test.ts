import { afterEach, expect, it, vi } from 'vitest';
import { tool } from '../../src/tools/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([undefined, {}])(
  'calls directly when the runtime has no process environment: %j',
  async (runtime) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const value = { bigint: 1n };
    let result: Promise<typeof value>;
    vi.stubGlobal('process', runtime);
    try {
      result = tool('direct', value, (args) => args);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await result).toBe(value);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['network', 'http'])(
  'preserves the original error when finish fails via %s',
  async (failure) => {
    vi.stubEnv('TAPEDIFF_PROXY_URL', 'http://localhost');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ action: 'run', id: 'token' })),
      );
    if (failure === 'network')
      fetch.mockRejectedValueOnce(new Error('private transport details'));
    else
      fetch.mockResolvedValueOnce(
        new Response('private response', { status: 500 }),
      );
    vi.stubGlobal('fetch', fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = new RangeError('original');
    await expect(
      tool('fail', {}, () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'warning: tapediff could not record the tool error; rethrowing the original error',
    );
  },
);

it.each(['network', 'http', 'json'])(
  'returns the real result when finish fails (%s)',
  async (failure) => {
    vi.stubEnv('TAPEDIFF_PROXY_URL', 'http://localhost');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ action: 'run', id: 'token' })),
      );
    const transport = new Error('network unavailable');
    if (failure === 'network') fetch.mockRejectedValueOnce(transport);
    else
      fetch.mockResolvedValueOnce(
        new Response('invalid JSON', {
          status: failure === 'http' ? 400 : 200,
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = tool('success', {}, () => 42);
    await expect(result).resolves.toBe(42);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'tapediff: could not record result of tool success; the tape will be missing it',
    );
  },
);

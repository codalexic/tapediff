/** A wrapped tool had no unconsumed recording with matching arguments. */
export class TapediffToolMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TapediffToolMissError';
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, (_key, item: unknown) => {
      if (item === undefined) return null;
      if (
        typeof item === 'function' ||
        typeof item === 'bigint' ||
        typeof item === 'symbol' ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw new TypeError();
      return item;
    });
  } catch {
    throw new TypeError(
      'tapediff tools must return JSON data and use JSON arguments (no functions, BigInt, cycles or non-finite numbers)',
    );
  }
}

async function post(
  base: string,
  route: string,
  body: string,
): Promise<Response> {
  const response = await fetch(
    `${base.replace(/\/$/, '')}/tapediff/v1/tools/${route}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    },
  );
  if (response.status === 409) {
    const value = (await response.json()) as { error: { message: string } };
    throw new TapediffToolMissError(value.error.message);
  }
  if (!response.ok)
    throw new Error(`tapediff tool ${route} failed (HTTP ${response.status})`);
  return response;
}

export async function tool<A, R>(
  name: string,
  args: A,
  fn: (args: A) => R,
): Promise<Awaited<R>> {
  const base = globalThis.process?.env?.TAPEDIFF_PROXY_URL;
  if (!base) return fn(args) as Awaited<R>;
  const response = await post(base, 'start', json({ name, args }));
  const reply = (await response.json()) as {
    action: 'run' | 'replay';
    id: string;
    result?: Awaited<R>;
    error?: { name: string; message: string };
  };
  if (reply.action === 'replay') {
    if (reply.error) {
      const error = new Error(reply.error.message);
      error.name = reply.error.name;
      throw Object.assign(error, { tapediffReplayed: true });
    }
    return reply.result as Awaited<R>;
  }
  let result: Awaited<R>;
  try {
    result = await fn(args);
  } catch (error) {
    try {
      await post(
        base,
        'finish',
        json({
          id: reply.id,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    } catch {
      console.warn(
        'warning: tapediff could not record the tool error; rethrowing the original error',
      );
    }
    throw error;
  }
  await post(base, 'finish', json({ id: reply.id, result: result ?? null }));
  return result;
}

export function wrapTool<A, R>(
  name: string,
  fn: (args: A) => R,
): (args: A) => Promise<Awaited<R>> {
  return (args) => tool(name, args, fn);
}

import pricing from '../pricing.json';
import type { Provider } from '../tape/schema.js';
import type { Usage } from './usage.js';

interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
const prices = Object.entries(pricing)
  .filter(
    (entry): entry is [string, Price] =>
      typeof entry[1] === 'object' && entry[1] !== null && 'input' in entry[1],
  )
  .sort((a, b) => b[0].length - a[0].length);

export function costUsd(
  model: string | undefined,
  usage: Usage | undefined,
  provider: Provider,
): number | null {
  const price = model
    ? prices.find(([prefix]) => model.startsWith(prefix))?.[1]
    : undefined;
  if (!price || !usage) return null;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  // OpenAI includes cached input in its input count; Anthropic reports it separately.
  const input =
    provider === 'openai'
      ? Math.max(0, usage.inputTokens - read - write)
      : usage.inputTokens;
  return (
    (input * price.input +
      usage.outputTokens * price.output +
      read * (price.cacheRead ?? price.input) +
      write * (price.cacheWrite ?? price.input)) /
    1_000_000
  );
}

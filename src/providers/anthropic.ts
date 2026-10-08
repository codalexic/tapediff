import { object, modelOf, tokens, type Metadata } from './usage.js';

/** message_delta usage is cumulative, and must not be added to message_start. */
export function extractAnthropic(
  value: unknown,
  previous: Metadata = {},
): Metadata {
  let body = object(value);
  if (body.type === 'message_start') body = object(body.message);
  const usage = object(body.usage);
  const result = { ...previous, model: modelOf(body) ?? previous.model };
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    result.usage = { inputTokens: 0, outputTokens: 0, ...previous.usage };
    if ('input_tokens' in usage)
      result.usage.inputTokens = tokens(usage.input_tokens);
    if ('output_tokens' in usage)
      result.usage.outputTokens = tokens(usage.output_tokens);
    if ('cache_read_input_tokens' in usage)
      result.usage.cacheReadTokens = tokens(usage.cache_read_input_tokens);
    if ('cache_creation_input_tokens' in usage)
      result.usage.cacheWriteTokens = tokens(usage.cache_creation_input_tokens);
  }
  return result;
}

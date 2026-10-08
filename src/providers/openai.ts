import { object, modelOf, tokens, type Metadata } from './usage.js';

/** Chat Completions (including include_usage) and Responses completed events. */
export function extractOpenAI(
  value: unknown,
  previous: Metadata = {},
): Metadata {
  let body = object(value);
  if (body.type === 'response.completed') body = object(body.response);
  const usage = object(body.usage);
  const result = { ...previous, model: modelOf(body) ?? previous.model };
  if ('prompt_tokens' in usage || 'input_tokens' in usage) {
    const details = object(
      usage.prompt_tokens_details ?? usage.input_tokens_details,
    );
    result.usage = {
      inputTokens: tokens(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: tokens(usage.completion_tokens ?? usage.output_tokens),
      ...('cached_tokens' in details
        ? { cacheReadTokens: tokens(details.cached_tokens) }
        : {}),
    };
  }
  return result;
}

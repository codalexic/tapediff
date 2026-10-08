import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { fetch } from 'undici';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const SDK = process.argv[2] === 'anthropic' ? Anthropic : OpenAI;
let requests = 0;
// Leave maxRetries at the SDK default: the response header must stop retries.
const client = new SDK({
  fetch: (...args) => {
    requests++;
    return fetch(...args);
  },
});
try {
  const params = {
    model: SDK === Anthropic ? 'claude-sonnet-4-5' : 'gpt-4o',
    messages: [{ role: 'user', content: 'Weather in Berlin?' }],
  };
  if (SDK === Anthropic)
    await client.messages.create({ ...params, max_tokens: 128 });
  else await client.chat.completions.create(params);
  assert.fail('expected a replay miss');
} catch (error) {
  assert.ok(error instanceof SDK.APIError);
  assert.equal(error.status, 500);
  assert.match(JSON.stringify(error.error), /tapediff_replay_miss/);
  assert.equal(requests, 1);
  console.log(`APIError status=${error.status} requests=${requests}`);
}
process.exitCode = Number(process.env.AGENT_EXIT_CODE ?? 0);

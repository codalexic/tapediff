import assert from 'node:assert/strict';
import process from 'node:process';
import { fetch } from 'undici';

const result = await fetch(`${process.env.ANTHROPIC_BASE_URL}/custom?x=1`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
  },
  body: JSON.stringify({ tool: { api_key: 'abc123' }, max_tokens: 100 }),
});
assert.equal(result.status, Number(process.env.EXPECT_STATUS ?? 200));
await result.text();

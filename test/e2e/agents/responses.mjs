import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import OpenAI from 'openai';

const client = new OpenAI({ maxRetries: 0 });
const stream = process.argv.includes('--stream');
const result = await client.responses.create({
  model: 'gpt-4.1',
  input: 'hello',
  stream,
});
if (stream) {
  let completed;
  for await (const event of result)
    if (event.type === 'response.completed') completed = event.response;
  console.log(completed.output[0].content[0].text);
  assert.equal(completed.usage.input_tokens, 100);
} else {
  console.log(result.output_text);
  assert.equal(result.usage.input_tokens, 100);
}

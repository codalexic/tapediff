import process from 'node:process';
import OpenAI from 'openai';

const client = new OpenAI({ maxRetries: 0 });
await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'prefix' }],
});
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'live stream' }],
  stream: true,
});
const iterator = stream[Symbol.asyncIterator]();
await iterator.next();
stream.controller.abort();
await iterator.return();
process.exitCode = 4;

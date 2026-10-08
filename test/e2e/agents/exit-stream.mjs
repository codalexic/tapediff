import process from 'node:process';
import OpenAI from 'openai';

const client = new OpenAI({ maxRetries: 0 });
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
});
await stream[Symbol.asyncIterator]().next();
process.exit(4);

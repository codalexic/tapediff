import process from 'node:process';
import console from 'node:console';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// One small paid request in record mode; the same SDK request on offline replay.
if (process.argv[2] === 'openai') {
  const client = new OpenAI({ maxRetries: 0, timeout: 30_000 });
  const response = await client.chat.completions.create({
    model: 'gpt-4.1-nano',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Say OK.' }],
  });
  console.log(response.choices[0].message.content);
} else if (process.argv[2] === 'anthropic') {
  const client = new Anthropic({ maxRetries: 0, timeout: 30_000 });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Say OK.' }],
  });
  console.log(
    response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
  );
} else throw new Error('Expected openai or anthropic');

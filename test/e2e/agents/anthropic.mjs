import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ maxRetries: 0 });
const stream = process.argv.includes('--stream');
const messages = [
  { role: 'user', content: process.env.AGENT_PROMPT ?? 'Weather in Paris?' },
];
const tools = [
  {
    name: 'lookup',
    description: 'Weather lookup',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];
for (let turn = 0; turn < 2; turn++) {
  const params = {
    model: 'claude-sonnet-4-5',
    max_tokens: 128,
    messages,
    tools,
  };
  const message = stream
    ? await client.messages.stream(params).finalMessage()
    : await client.messages.create(params);
  messages.push({ role: 'assistant', content: message.content });
  if (turn === 0) {
    const call = message.content[0];
    assert.equal(call.type, 'tool_use');
    assert.deepEqual(call.input, { city: 'Paris' });
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: call.id, content: 'sunny' },
      ],
    });
  } else {
    assert.equal(message.content[0].text, 'It is sunny.');
    console.log(message.content[0].text);
  }
}
process.exitCode = Number(process.env.AGENT_EXIT_CODE ?? 0);

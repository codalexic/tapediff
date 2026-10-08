import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import OpenAI from 'openai';

const client = new OpenAI({ maxRetries: 0 });
const stream = process.argv.includes('--stream');
const messages = [
  { role: 'user', content: process.env.AGENT_PROMPT ?? 'Weather in Paris?' },
];
const tools = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Weather lookup',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];
for (let turn = 0; turn < 2; turn++) {
  let message;
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages,
    tools,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
  if (stream) {
    message = { role: 'assistant', content: '' };
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) message.content += delta.content;
      for (const call of delta?.tool_calls ?? []) {
        message.tool_calls ??= [];
        const tool = (message.tool_calls[call.index] ??= {
          id: call.id,
          type: 'function',
          function: { name: call.function?.name, arguments: '' },
        });
        tool.function.arguments += call.function?.arguments ?? '';
      }
    }
  } else message = response.choices[0].message;
  messages.push(message);
  if (turn === 0) {
    const call = message.tool_calls[0];
    assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Paris' });
    messages.push({ role: 'tool', tool_call_id: call.id, content: 'sunny' });
  } else {
    assert.equal(message.content, 'It is sunny.');
    console.log(message.content);
  }
}
process.exitCode = Number(process.env.AGENT_EXIT_CODE ?? 0);

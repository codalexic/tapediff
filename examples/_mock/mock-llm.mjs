import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

// Stateless rules make concurrent agents independent. No API keys or network calls.
function nextReply(body) {
  const firstUser = body.messages.find((message) => message.role === 'user');
  const city = String(firstUser?.content).includes('Tokyo') ? 'Tokyo' : 'Paris';
  const system =
    body.system ??
    body.messages.find((message) => message.role === 'system')?.content ??
    '';
  if (system.startsWith('Draft a day plan.'))
    return {
      type: 'text',
      text: `Paris: sunny, 22 ${system.includes('as Celsius') ? 'C' : 'F'}. Budget: 92 EUR. Walk by the Seine.`,
    };
  if (system.startsWith('Review the day plan'))
    return {
      type: 'text',
      text: String(firstUser?.content).includes('22 F')
        ? 'FAIL: the forecast is 22 C, not 22 F. The 92 EUR budget is correct.'
        : 'PASS: the plan matches 22 C and the 92 EUR budget.',
    };
  const calls = body.messages
    .filter((message) => message.role === 'assistant')
    .flatMap(
      (message) =>
        message.tool_calls?.map((call) => call.function.name) ??
        message.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => block.name),
    );
  let name, input;
  if (!calls.includes('get_weather')) {
    name = 'get_weather';
    input = { city };
  } else if (!calls.includes('convert_currency')) {
    name = 'convert_currency';
    input = { amount: 100, from: 'USD', to: city === 'Tokyo' ? 'JPY' : 'EUR' };
    if (system.startsWith('Research the trip.'))
      input = { amount: 100, source: 'USD', target: 'EUR' };
  } else if (
    system.includes('call get_weather twice') &&
    calls.filter((call) => call === 'get_weather').length < 2
  ) {
    name = 'get_weather';
    input = { city };
  }
  if (name)
    return { type: 'tool_use', id: `tool_${calls.length + 1}`, name, input };
  const results = body.messages.flatMap((message) =>
    message.role === 'tool'
      ? [JSON.parse(message.content)]
      : Array.isArray(message.content)
        ? message.content
            .filter((block) => block.type === 'tool_result')
            .map((block) => JSON.parse(block.content))
        : [],
  );
  const weather = results.find((result) => result.condition);
  const budget = results.find((result) => result.currency);
  return {
    type: 'text',
    text: `${city}: ${weather.condition}, ${weather.temperature_c} C. Your 100 USD is ${budget.amount} ${budget.currency}. ${city === 'Tokyo' ? 'Pack an umbrella.' : 'Enjoy a walk by the Seine.'}`,
  };
}

async function anthropicSse(response, body, block) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const event = async (type, data) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
    // Yield between deltas so the recorder captures a genuine streamed response.
    await setImmediate();
  };
  await event('message_start', {
    message: {
      id: 'msg_trip',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  const tool = block.type === 'tool_use';
  await event('content_block_start', {
    index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  const payload = tool ? JSON.stringify(block.input) : block.text;
  const middle = Math.floor(payload.length / 2);
  for (const part of [payload.slice(0, middle), payload.slice(middle)]) {
    await event('content_block_delta', {
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: part }
        : { type: 'text_delta', text: part },
    });
  }
  await event('content_block_stop', { index: 0 });
  await event('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 25 },
  });
  await event('message_stop', {});
  response.end();
}

export async function startMock() {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        request.method !== 'POST' ||
        !['/v1/chat/completions', '/v1/messages'].includes(request.url)
      ) {
        response.writeHead(404).end();
        return;
      }
      const block = nextReply(body);
      if (request.url === '/v1/messages') {
        if (!body.stream)
          throw new Error('Anthropic example requires streaming');
        await anthropicSse(response, body, block);
        return;
      }
      const tool = block.type === 'tool_use';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl_trip',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: tool ? 'tool_calls' : 'stop',
              message: tool
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: block.id,
                        type: 'function',
                        function: {
                          name: block.name,
                          arguments: JSON.stringify(block.input),
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: block.text },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
          },
        }),
      );
    })().catch(() => {
      // Never echo request bodies or authentication on errors.
      if (!response.headersSent)
        response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Unsupported mock trip request' } }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const mock = await startMock();
  console.log(`Local mock LLM: ${mock.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void mock.close();
    });
}

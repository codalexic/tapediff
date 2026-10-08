import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import console from 'node:console';
import Anthropic from '@anthropic-ai/sdk';

export const PROMPT =
  'You are a concise trip helper. Use get_weather and convert_currency before answering.';
export const REGRESSED_PROMPT = `${PROMPT} Double-check the forecast: call get_weather twice before answering.`;

/** @param {string} city */
function get_weather(city) {
  const forecasts = {
    Paris: { condition: 'sunny', temperature_c: 22 },
    Tokyo: { condition: 'rainy', temperature_c: 18 },
  };
  if (!(city in forecasts)) throw new Error(`Unknown city: ${city}`);
  return { city, ...forecasts[city] };
}

/** @param {number} amount @param {string} from @param {string} to */
function convert_currency(amount, from, to) {
  const rate = { 'USD/EUR': 0.92, 'USD/JPY': 150 }[`${from}/${to}`];
  if (!rate) throw new Error('Unknown currency pair');
  return { amount: Math.round(amount * rate * 100) / 100, currency: to };
}

const tools = [
  {
    name: 'get_weather',
    description: 'Get the demo forecast for a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  {
    name: 'convert_currency',
    description: 'Convert a travel budget using demo rates.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
  },
];

/** @param {string} [system] */
export async function main(system = PROMPT) {
  const scenario = path
    .parse(process.argv[2] ?? process.env.TAPEDIFF_TAPE ?? 'paris')
    .name.toLowerCase();
  const [city, currency] =
    scenario === 'tokyo' ? ['Tokyo', 'JPY'] : ['Paris', 'EUR'];
  const client = new Anthropic({ maxRetries: 0, timeout: 20_000 });
  const messages = [
    {
      role: 'user',
      content: `Plan a day in ${city}. What is the weather, and what is 100 USD in ${currency}?`,
    },
  ];
  for (let turn = 0; turn < 6; turn++) {
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system,
      messages,
      tools,
    });
    stream.on('text', (text) => process.stdout.write(text));
    const reply = await stream.finalMessage();
    messages.push({ role: 'assistant', content: reply.content });
    const results = [];
    for (const call of reply.content) {
      if (call.type !== 'tool_use') continue;
      const args = call.input;
      let result;
      if (call.name === 'get_weather') result = get_weather(args.city);
      else if (call.name === 'convert_currency')
        result = convert_currency(args.amount, args.from, args.to);
      else throw new Error(`Unknown tool: ${call.name}`);
      console.log(`tool ${call.name}: ${JSON.stringify(result)}`);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
      });
    }
    if (!results.length) {
      process.stdout.write('\n');
      return;
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Trip helper exceeded its tool-call budget');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();

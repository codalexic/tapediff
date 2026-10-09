import process from 'node:process';
import OpenAI from 'openai';

const client = new OpenAI({ maxRetries: 0 });
for (let call = 1; call <= Number(process.env.AGENT_CALLS ?? 3); call++) {
  await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content:
          call === 2
            ? (process.env.AGENT_SECOND_PROMPT ?? 'Call 2')
            : `Call ${call}`,
      },
    ],
  });
}

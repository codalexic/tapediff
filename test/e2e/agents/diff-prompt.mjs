import process from 'node:process';
import { fetch } from 'undici';

const response = await fetch(
  `${process.env.OPENAI_BASE_URL}/chat/completions`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: process.argv[2] }],
    }),
  },
);
if (!response.ok) throw new Error('fake upstream failed');
await response.json();

import { expect, it } from 'vitest';
import { SseParser } from '../../src/proxy/sse.js';
import { redactBody, redactSse } from '../../src/tape/redact.js';

it('parses SSE split at every byte, including CRLF and UTF-8 decoding', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = [
      'event: update',
      ': comment',
      'data: {"text":',
      'data: "hé🌍"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join(newline);
    const bytes = Buffer.from(text);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const frames = [
        ...parser.push(
          decoder.decode(bytes.subarray(0, split), { stream: true }),
        ),
        ...parser.push(decoder.decode(bytes.subarray(split), { stream: true })),
        ...parser.push(decoder.decode(), true),
      ];
      expect(frames.map((f) => f.raw).join('')).toBe(text);
      expect(frames.map((f) => f.data)).toEqual([
        '{"text":\n"hé🌍"}',
        '[DONE]',
      ]);
      expect(frames[0]?.event).toBe('update');
    }
    const parser = new SseParser();
    const frames = [...text].flatMap((char) => parser.push(char));
    frames.push(...parser.push('', true));
    expect(frames).toHaveLength(2);
  }
});

it('redacts credential property values without touching token counts', () => {
  const keys = [
    'api-key',
    'apikey',
    'X-Api-Key',
    'secret',
    'client_secret',
    'client-secret',
    'password',
    'passwd',
    'access_token',
    'refresh-token',
    'auth_token',
    'authorization',
    'bearer',
  ];
  for (const key of keys)
    expect(redactBody({ [key]: 'abc123' })).toEqual({ [key]: '[REDACTED]' });
  expect(
    redactBody({
      tool: { api_key: 'abc123' },
      max_tokens: '100',
      input_tokens: 10,
      output_tokens: 20,
      secret: 7,
    }),
  ).toEqual({
    tool: { api_key: '[REDACTED]' },
    max_tokens: '100',
    input_tokens: 10,
    output_tokens: 20,
    secret: 7,
  });
});

it('keeps later SSE events and timestamps aligned after length-changing redaction', () => {
  const first = 'data: {"text":"sk-proj-abcdefghijklmnopqrstuvwxyz"}\r\n\r\n';
  const second = 'data: {"text":"safe"}\n\n';
  for (let split = 1; split < first.length; split++) {
    expect(
      redactSse([
        { t: 1, data: first.slice(0, split) },
        { t: 2, data: first.slice(split) },
        { t: 50, data: second },
      ]),
    ).toEqual([
      { t: 1, data: 'data: {"text":"[REDACTED]"}\r\n\r\n' },
      { t: 50, data: second },
    ]);
  }
  expect(
    redactSse([{ t: 0, data: 'data: {"tool":{"api_key":"abc123"}}\n\n' }])[0]
      ?.data,
  ).toContain('"api_key":"[REDACTED]"');
});

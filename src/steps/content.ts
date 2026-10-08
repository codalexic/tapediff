import { object } from '../providers/usage.js';
import type { JsonValue } from '../tape/schema.js';

export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const string = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Text blocks are concatenated in their original order; non-text blocks are ignored. */
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return list(value)
    .map((block) => string(object(block).text))
    .join('');
}

export function parseArgs(value: unknown): JsonValue {
  if (typeof value !== 'string') return (value ?? {}) as JsonValue;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

export type OutputStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool_call'; id: string; name: string; args: JsonValue };

export function chatOutput(message: unknown): OutputStep[] {
  const body = object(message);
  const text = contentText(body.content);
  return [
    ...(text ? [{ kind: 'text' as const, content: text }] : []),
    ...list(body.tool_calls).map((value): OutputStep => {
      const call = object(value);
      const fn = object(call.function);
      return {
        kind: 'tool_call',
        id: string(call.id),
        name: string(fn.name),
        args: parseArgs(fn.arguments),
      };
    }),
  ];
}

export function blockOutput(value: unknown): OutputStep[] {
  const block = object(value);
  if (block.type === 'text' || block.type === 'output_text')
    return typeof block.text === 'string' && block.text
      ? [{ kind: 'text', content: block.text }]
      : [];
  if (block.type === 'message') return list(block.content).flatMap(blockOutput);
  if (block.type === 'tool_use' || block.type === 'function_call')
    return [
      {
        kind: 'tool_call',
        id: string(block.call_id ?? block.id),
        name: string(block.name),
        args: parseArgs(
          block.type === 'tool_use' ? block.input : block.arguments,
        ),
      },
    ];
  return [];
}

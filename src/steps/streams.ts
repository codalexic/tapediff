import { object } from '../providers/usage.js';
import { SseParser } from '../proxy/sse.js';
import type { SseChunk } from '../tape/schema.js';
import {
  blockOutput,
  list,
  parseArgs,
  string,
  type OutputStep,
} from './content.js';

/** Chunk boundaries need not coincide with SSE frames or JSON boundaries. */
export function streamEvents(chunks: SseChunk[]): Record<string, unknown>[] {
  const parser = new SseParser();
  return [
    ...chunks.flatMap((chunk) => parser.push(chunk.data)),
    ...parser.push('', true),
  ].flatMap((frame) => {
    try {
      const value = object(JSON.parse(frame.data));
      return [{ ...value, type: value.type ?? frame.event }];
    } catch {
      return []; // Comments, [DONE], and truncated JSON carry no structured output.
    }
  });
}

export function chatStream(events: Record<string, unknown>[]): OutputStep[] {
  const output: OutputStep[] = [];
  const calls = new Map<string, Extract<OutputStep, { kind: 'tool_call' }>>();
  const textByChoice = new Map<number, Extract<OutputStep, { kind: 'text' }>>();
  for (const event of events) {
    for (const [position, value] of list(event.choices).entries()) {
      const choice = object(value);
      const choiceIndex =
        typeof choice.index === 'number' ? choice.index : position;
      const delta = object(choice.delta);
      if (typeof delta.content === 'string' && delta.content) {
        let text = textByChoice.get(choiceIndex);
        if (!text) {
          text = { kind: 'text', content: '' };
          textByChoice.set(choiceIndex, text);
          output.push(text);
        }
        text.content += delta.content;
      }
      for (const [position, value] of list(delta.tool_calls).entries()) {
        const deltaCall = object(value);
        const index =
          typeof deltaCall.index === 'number' ? deltaCall.index : position;
        const key = `${choiceIndex}:${index}`;
        let call = calls.get(key);
        if (!call) {
          call = { kind: 'tool_call', id: '', name: '', args: '' };
          calls.set(key, call);
          output.push(call);
          // Text emitted after a tool call belongs after it in the timeline.
          textByChoice.delete(choiceIndex);
        }
        const fn = object(deltaCall.function);
        call.id += string(deltaCall.id);
        call.name += string(fn.name);
        call.args = string(call.args) + string(fn.arguments);
      }
    }
  }
  for (const call of calls.values()) call.args = parseArgs(call.args);
  return output;
}

export function anthropicStream(
  events: Record<string, unknown>[],
): OutputStep[] {
  const blocks = new Map<number, Record<string, unknown>>();
  const args = new Map<number, string>();
  for (const event of events) {
    const index = typeof event.index === 'number' ? event.index : 0;
    if (event.type === 'content_block_start')
      blocks.set(index, { ...object(event.content_block) });
    if (event.type !== 'content_block_delta') continue;
    const block = blocks.get(index);
    if (!block) continue;
    const delta = object(event.delta);
    if (delta.type === 'text_delta')
      block.text = string(block.text) + string(delta.text);
    if (delta.type === 'input_json_delta')
      args.set(index, (args.get(index) ?? '') + string(delta.partial_json));
  }
  return [...blocks]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, block]) =>
      blockOutput(
        args.has(index)
          ? { ...block, input: parseArgs(args.get(index)) }
          : block,
      ),
    );
}

export function responsesStream(
  events: Record<string, unknown>[],
): OutputStep[] {
  const items = new Map<number, Record<string, unknown>>();
  let completed: unknown[] | undefined;
  for (const event of events) {
    const index =
      typeof event.output_index === 'number' ? event.output_index : 0;
    if (
      event.type === 'response.completed' &&
      Array.isArray(object(event.response).output)
    )
      completed = list(object(event.response).output);
    if (
      event.type === 'response.output_item.added' ||
      event.type === 'response.output_item.done'
    )
      items.set(index, { ...object(event.item) });
    const item = items.get(index);
    if (event.type === 'response.function_call_arguments.delta' && item)
      item.arguments = string(item.arguments) + string(event.delta);
    if (event.type === 'response.output_text.delta') {
      const message = item ?? { type: 'message', content: [] };
      const content = [...list(message.content)];
      const partIndex =
        typeof event.content_index === 'number' ? event.content_index : 0;
      const part = object(content[partIndex]);
      content[partIndex] = {
        type: 'output_text',
        text: string(part.text) + string(event.delta),
      };
      message.content = content;
      items.set(index, message);
    }
  }
  // The completed response is authoritative, avoiding duplicate done items/deltas.
  return (
    completed ?? [...items].sort(([a], [b]) => a - b).map(([, item]) => item)
  ).flatMap(blockOutput);
}

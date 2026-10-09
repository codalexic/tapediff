import { object } from '../providers/usage.js';
import {
  blockOutput,
  chatOutput,
  contentText,
  list,
  string,
  type OutputStep,
} from '../steps/content.js';
import type { Exchange } from '../tape/schema.js';

export function outputParts(steps: OutputStep[]) {
  return steps.map((step) =>
    step.kind === 'text'
      ? { type: 'text', content: step.content }
      : {
          type: 'tool_call',
          ...(step.id ? { id: step.id } : {}),
          name: step.name,
          arguments: step.args,
        },
  );
}

/** Preserve message order and roles; binary and unsupported parts are omitted. */
export function inputMessages(exchange: Exchange) {
  const body = object(exchange.request.body);
  const responses = exchange.endpoint.split('?')[0]?.endsWith('/responses');
  const input = responses ? body.input : body.messages;
  if (typeof input === 'string')
    return [{ role: 'user', parts: [{ type: 'text', content: input }] }];
  return list(input).map((value) => {
    const message = object(value);
    if (message.type === 'function_call')
      return { role: 'assistant', parts: outputParts(blockOutput(message)) };
    if (message.type === 'function_call_output' || message.role === 'tool')
      return {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: string(message.call_id ?? message.tool_call_id),
            response: message.output ?? message.content ?? null,
          },
        ],
      };
    const role =
      message.role === 'developer' ? 'system' : string(message.role) || 'user';
    if (exchange.provider === 'openai')
      return { role, parts: outputParts(chatOutput(message)) };
    const parts =
      typeof message.content === 'string'
        ? [{ type: 'text', content: message.content }]
        : list(message.content).flatMap((value): Record<string, unknown>[] => {
            const block = object(value);
            return block.type === 'tool_result'
              ? [
                  {
                    type: 'tool_call_response',
                    id: string(block.tool_use_id),
                    response: block.content ?? null,
                  },
                ]
              : outputParts(blockOutput(block));
          });
    return { role, parts };
  });
}

export function systemInstructions(exchange: Exchange) {
  const body = object(exchange.request.body);
  const text = contentText(
    exchange.provider === 'anthropic' ? body.system : body.instructions,
  );
  return text ? [{ type: 'text', content: text }] : [];
}

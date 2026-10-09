import { object } from '../providers/usage.js';
import { list } from './content.js';
import type { Exchange } from '../tape/schema.js';

/** Read metadata from the same parsed stream events used by responseSteps. */
export function responseMetadata(
  exchange: Exchange,
  events: Record<string, unknown>[],
) {
  let id: string | undefined;
  let model: string | undefined;
  const reasons = new Map<number, string>();
  const responses = exchange.endpoint.split('?')[0]?.endsWith('/responses');
  for (const value of [exchange.response.body, ...events]) {
    const event = object(value);
    const body = object(event.response ?? event.message ?? value);
    if (typeof body.id === 'string') id = body.id;
    if (typeof body.model === 'string') model = body.model;
    if (exchange.provider === 'anthropic') {
      const reason = body.stop_reason ?? object(body.delta).stop_reason;
      if (typeof reason === 'string') reasons.set(0, reason);
    } else if (responses) {
      const status =
        body.status ??
        (event.type === 'response.completed' ? 'completed' : undefined);
      if (status === 'completed') reasons.set(0, 'stop');
      if (status === 'failed' || status === 'cancelled')
        reasons.set(0, 'error');
      if (status === 'incomplete') {
        const reason = object(body.incomplete_details).reason;
        if (typeof reason === 'string')
          reasons.set(0, reason === 'max_output_tokens' ? 'length' : reason);
      }
    } else {
      for (const [position, value] of list(body.choices).entries()) {
        const choice = object(value);
        if (typeof choice.finish_reason === 'string')
          reasons.set(
            typeof choice.index === 'number' ? choice.index : position,
            choice.finish_reason,
          );
      }
    }
  }
  return {
    id,
    model,
    finishReasons: [...reasons]
      .sort(([a], [b]) => a - b)
      .map(([, reason]) => reason),
  };
}

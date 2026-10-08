import type { Exchange } from '../tape/schema.js';

export type Usage = NonNullable<Exchange['usage']>;
export interface Metadata {
  model?: string;
  usage?: Usage;
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
export function modelOf(value: unknown): string | undefined {
  const model = object(value).model;
  return typeof model === 'string' ? model : undefined;
}

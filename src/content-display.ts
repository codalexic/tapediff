import type { JsonValue } from './tape/schema.js';

/** Decode containers only, without changing stored steps or the JSON contract. */
export function jsonContainer(
  content: string,
): JsonValue[] | { [key: string]: JsonValue } | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === 'object')
      return value as JsonValue[] | { [key: string]: JsonValue };
  } catch {
    // Plain text and incomplete JSON retain their original representation.
  }
  return undefined;
}

export function displayContent(content: string, quoteText = true): string {
  const value = jsonContainer(content);
  return value === undefined
    ? quoteText
      ? JSON.stringify(content)
      : content
    : JSON.stringify(value);
}

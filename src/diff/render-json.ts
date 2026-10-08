import type { RunDiff } from './index.js';

/** Recursively sort object keys so even caller-supplied argument ordering is stable. */
export function renderJson(diff: RunDiff): string {
  return `${JSON.stringify(
    diff,
    (_key, value: unknown): unknown => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return Object.fromEntries(
          Object.entries(value).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        );
      return value;
    },
    2,
  )}\n`;
}

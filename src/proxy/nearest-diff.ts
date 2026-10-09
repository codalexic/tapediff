import { createTwoFilesPatch } from 'diff';
import { canonicalJson } from '../tape/normalize.js';
import { parseRedactPatterns, redactBody } from '../tape/redact.js';
import type { JsonValue } from '../tape/schema.js';

/** Shared canonical lines; ties retain candidate order. */
export function nearestDiff(
  value: JsonValue,
  candidates: readonly JsonValue[],
  labels: { recorded: string; incoming: string; missing: string },
): string {
  const patterns = parseRedactPatterns(process.env.TAPEDIFF_REDACT);
  const pretty = (value: JsonValue) =>
    `${JSON.stringify(JSON.parse(canonicalJson(redactBody(value, patterns))) as JsonValue, null, 2)}\n`;
  const actual = pretty(value);
  const lines = new Set(actual.split('\n'));
  let nearest: string | undefined;
  let best = -1;
  for (const candidate of candidates) {
    const expected = pretty(candidate);
    const score = [...new Set(expected.split('\n'))].filter((line) =>
      lines.has(line),
    ).length;
    if (score > best) {
      nearest = expected;
      best = score;
    }
  }
  return nearest === undefined
    ? `${labels.missing}${actual}`
    : createTwoFilesPatch(labels.recorded, labels.incoming, nearest, actual);
}

import { diffWordsWithSpace } from 'diff';
import { terminalLine } from '../terminal.js';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A compact word diff with context around the first edit, in terminal cells. */
export function textWindow(a: string, b: string, width: number): string {
  const parts = diffWordsWithSpace(a, b);
  const first = parts.findIndex((part) => part.added || part.removed);
  const context = Math.min(24, Math.max(0, Math.floor(width / 4)));
  let prefix = parts
    .slice(0, first)
    .map((part) => part.value)
    .join('');
  if (terminalLine(prefix, context) !== prefix) {
    const segments = Array.from(
      graphemes.segment(prefix),
      ({ segment }) => segment,
    );
    prefix = context === 0 ? '' : segments.slice(-context).join('');
    while (prefix && terminalLine(prefix, context) !== prefix)
      prefix = Array.from(graphemes.segment(prefix), ({ segment }) => segment)
        .slice(1)
        .join('');
    // Prefer whole-word context when there is a word boundary in the window.
    const boundary = prefix.search(/\s/u);
    if (boundary >= 0) prefix = prefix.slice(boundary + 1);
    prefix = `…${prefix}`;
  }
  const changed = parts
    .slice(Math.max(0, first))
    .map((part) =>
      part.removed
        ? `[-${part.value}-]`
        : part.added
          ? `{+${part.value}+}`
          : part.value,
    )
    .join('');
  return terminalLine(prefix + changed, Math.max(1, width));
}

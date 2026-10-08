const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function columns(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  const code = segment.codePointAt(0)!;
  // Wide CJK/fullwidth characters and emoji occupy two terminal cells.
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ||
    (code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd)))
    ? 2
    : 1;
}

/** Escape terminal controls, then truncate by display cells without splitting graphemes. */
export function terminalLine(value: string, width: number): string {
  const safe = value.replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
    char === '\u200d'
      ? char
      : `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
  const segments = Array.from(graphemes.segment(safe), ({ segment }) => ({
    text: segment,
    width: columns(segment),
  }));
  if (segments.reduce((sum, segment) => sum + segment.width, 0) <= width)
    return safe;
  let result = '';
  let used = 0;
  for (const segment of segments) {
    if (used + segment.width > width - 1) break;
    result += segment.text;
    used += segment.width;
  }
  return `${result}…`;
}

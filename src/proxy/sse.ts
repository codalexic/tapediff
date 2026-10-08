export interface SseFrame {
  raw: string;
  data: string;
  event?: string;
}

/** Incremental SSE framing. CR, LF, CRLF and multi-line data are supported. */
export class SseParser {
  private buffer = '';
  private cursor = 0;
  private lineStart = 0;

  push(text: string, final = false): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    while (this.cursor < this.buffer.length) {
      const char = this.buffer[this.cursor];
      if (char !== '\r' && char !== '\n') {
        this.cursor++;
        continue;
      }
      if (char === '\r' && this.cursor + 1 === this.buffer.length && !final)
        break;
      const end =
        this.cursor +
        (char === '\r' && this.buffer[this.cursor + 1] === '\n' ? 2 : 1);
      const blank = this.cursor === this.lineStart;
      this.cursor = end;
      this.lineStart = end;
      if (blank) {
        frames.push(parseFrame(this.buffer.slice(0, end)));
        this.buffer = this.buffer.slice(end);
        this.cursor = this.lineStart = 0;
      }
    }
    if (final && this.buffer) {
      frames.push(parseFrame(this.buffer));
      this.buffer = '';
      this.cursor = this.lineStart = 0;
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
  }
  return {
    raw,
    data: data.join('\n'),
    ...(event === undefined ? {} : { event }),
  };
}

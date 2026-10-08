import { readTapeOrFail } from '../tape/read-or-fail.js';
import { toSteps } from '../steps.js';
import { diffRuns, type Run } from '../diff/index.js';
import { renderText } from '../diff/render-text.js';
import { renderJson } from '../diff/render-json.js';
import { useColor } from '../format.js';

export interface DiffOptions {
  json?: boolean;
  tui?: boolean;
  color?: boolean;
}

async function readRun(path: string): Promise<Run> {
  const data = await readTapeOrFail(path);
  return {
    name: data.header.name ?? null,
    path,
    createdAt: data.header.createdAt,
    steps: toSteps(data.exchanges),
  };
}

export async function diffCommand(
  a: string,
  b: string,
  options: DiffOptions,
): Promise<number> {
  const [left, right] = await Promise.all([readRun(a), readRun(b)]);
  const result = diffRuns(left, right);
  if (options.tui && !options.json) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const { showDiff } = await import('../tui/index.js');
      await showDiff(result, useColor(options.color));
      return result.identical ? 0 : 1;
    }
    process.stderr.write(
      'warning: --tui requires a TTY on stdout and stdin; falling back to text output\n',
    );
  }
  process.stdout.write(
    options.json
      ? renderJson(result)
      : renderText(
          result,
          process.stdout.columns ?? 100,
          useColor(options.color),
        ),
  );
  return result.identical ? 0 : 1;
}

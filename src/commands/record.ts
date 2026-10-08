import { unlink } from 'node:fs/promises';
import { runChild } from './run-child.js';

import { createProxy } from '../proxy/server.js';
import { createRecordHandler } from '../proxy/record.js';
import { TapeWriter } from '../tape/io.js';
import { redactBody } from '../tape/redact.js';
import { version } from '../version.js';
import { money, tokens } from '../format.js';
import { addCallTotals, stepTotals } from '../totals.js';
import { toSteps } from '../steps.js';

export interface RecordOptions {
  out: string;
  name?: string;
  force?: boolean;
}

export async function recordCommand(
  command: string[],
  options: RecordOptions,
): Promise<number> {
  if (!command[0]) throw new Error('record requires a child command');
  const env = { ...process.env };
  if (options.force) {
    try {
      await unlink(options.out);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw new Error('cannot replace output tape', { cause: error });
    }
  }
  let writer: TapeWriter;
  try {
    writer = await TapeWriter.open(options.out, {
      tapediff: 1,
      createdAt: new Date().toISOString(),
      command,
      ...(options.name === undefined ? {} : { name: options.name }),
      tool: { name: 'tapediff', version },
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('output tape exists; use --force to overwrite', {
        cause: error,
      });
    throw new Error('cannot create output tape', { cause: error });
  }
  let totals = stepTotals([]);
  let unknownCost = 0;
  try {
    const proxy = await createProxy({
      mode: 'record',
      env,
      handler: createRecordHandler(writer, (exchange) => {
        for (const step of toSteps([exchange])) {
          if (step.kind !== 'llm_call') continue;
          totals = addCallTotals(totals, step);
          if (step.costUsd === null) unknownCost++;
        }
      }),
    });
    const code = await runChild(command, proxy, env);
    await writer.close();
    const costText = `${money(totals.costUsd)}${unknownCost ? ` (${unknownCost} unpriced)` : ''}`;
    process.stderr.write(
      `recorded ${totals.calls} exchanges · ${tokens(totals.tokens)} tokens · ${costText} → ${redactBody(options.out) as string}\n`,
    );
    return code;
  } finally {
    await writer.close();
  }
}

import path from 'node:path';
import { createProxy } from '../proxy/server.js';
import { createForkHandler, type ForkOptions } from '../proxy/fork.js';
import { readTapeOrFail } from '../tape/read-or-fail.js';
import { redactBody } from '../tape/redact.js';
import { money, tokens } from '../format.js';
import { addCallTotals, stepTotals } from '../totals.js';
import { toSteps } from '../steps.js';
import { version } from '../version.js';
import { diffCommand } from './diff.js';
import { openOutputTape } from './output-tape.js';
import { runChild } from './run-child.js';

export interface ForkCommandOptions extends ForkOptions {
  out?: string;
  force?: boolean;
  diff?: boolean;
  color?: boolean;
}

export function forkOutputPath(tape: string, paths = path): string {
  return paths.join(
    paths.dirname(tape),
    `${paths.basename(tape, '.tape')}.fork.tape`,
  );
}

export async function forkCommand(
  tape: string,
  command: string[],
  options: ForkCommandOptions = {},
): Promise<number> {
  const source = await readTapeOrFail(tape);
  const out = options.out ?? forkOutputPath(tape);
  const tapePath = path.resolve(tape);
  const env: NodeJS.ProcessEnv = { ...process.env, TAPEDIFF_TAPE: tapePath };
  const childCommand = command.map((arg) => arg.replaceAll('{tape}', tapePath));
  const writer = await openOutputTape(
    out,
    {
      tapediff: 1,
      createdAt: new Date().toISOString(),
      command: childCommand,
      tool: { name: 'tapediff', version },
      forkedFrom: {
        tape,
        at: options.at ?? null,
        mode: options.at === undefined ? 'divergence' : 'positional',
        sourceCreatedAt: source.header.createdAt,
      },
    },
    options.force,
  );
  let saved = stepTotals([]);
  let live = 0;
  let failed = false;
  const fork = createForkHandler(
    source.exchanges,
    writer,
    options,
    (exchange) => {
      if (exchange.provider === 'unknown') return;
      if (!exchange.servedFrom) live++;
      else
        for (const step of toSteps([exchange])) {
          if (step.kind === 'llm_call') saved = addCallTotals(saved, step);
        }
    },
  );
  try {
    const proxy = await createProxy({
      mode: 'fork',
      env,
      handler: fork.handler,
    });
    const close = proxy.close.bind(proxy);
    // Keep runChild's signal handling while distinguishing proxy failure from setup errors.
    proxy.close = async () => {
      try {
        await close();
      } catch {
        failed = true;
      }
    };
    if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY)
      process.stderr.write(
        'warning: neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set; live requests may need credentials\n',
      );
    const code = await runChild(childCommand, proxy, env);
    try {
      await writer.close();
    } catch {
      failed = true;
    }
    process.stderr.write(
      `fork: ${saved.calls} ${saved.calls === 1 ? 'call' : 'calls'} from tape · ${live} live · saved ${money(saved.costUsd)} (${tokens(saved.tokens)} ${saved.tokens === 1 ? 'token' : 'tokens'}) → ${redactBody(out) as string}\n`,
    );
    const stats = fork.stats;
    if (stats.changed)
      process.stderr.write(
        `${stats.changed} ${stats.changed === 1 ? 'call was' : 'calls were'} served from the tape even though ${stats.changed === 1 ? 'its request' : 'their requests'} changed; see docs/fork.md\n`,
      );
    if (!stats.live && stats.unconsumed)
      process.stderr.write(
        `warning: ${stats.unconsumed} recorded ${stats.unconsumed === 1 ? 'call was' : 'calls were'} never requested\n`,
      );
    if (failed) process.stderr.write('error: fork proxy failed\n');
    if (options.diff) {
      try {
        await diffCommand(tape, out, { color: options.color });
      } catch {
        process.stderr.write('error: cannot compare fork tapes\n');
      }
    }
    return failed ? 3 : code;
  } finally {
    try {
      await writer.close();
    } catch {
      /* A failed append was already reported by the writer. */
    }
  }
}

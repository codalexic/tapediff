import { Command, Option, InvalidArgumentError } from 'commander';

import { version } from './version.js';
import { recordCommand, type RecordOptions } from './commands/record.js';
import { forkCommand, type ForkCommandOptions } from './commands/fork.js';
import { replayCommand } from './commands/replay.js';
import { testCommand } from './commands/test.js';
import { showCommand } from './commands/show.js';
import type { ExportCommandOptions } from './commands/export.js';
import { diffCommand, type DiffOptions } from './commands/diff.js';
import type { ReplayOptions } from './proxy/replay.js';

export function createProgram(): Command {
  const program = new Command()
    .name('tapediff')
    .description('Snapshot testing for AI agents.')
    .version(version)
    .option('--verbose', 'enable verbose logging')
    .exitOverride();

  program
    .command('record')
    .description('Record an agent’s LLM traffic to a tape')
    .argument('<cmd...>', 'command to run (after --)')
    .option('--out <tape>', 'output tape path', 'run.tape')
    .option('--name <label>', 'label for the recording')
    .option('--force', 'overwrite an existing output tape')
    .action(async (command: string[], options: RecordOptions) => {
      process.exitCode = await recordCommand(command, options);
    });

  program
    .command('replay')
    .description('Replay a tape deterministically')
    .argument('<tape>', 'tape to replay')
    .argument('<cmd...>', 'command to run (after --)')
    .addOption(
      new Option(
        '--strict',
        'require exact request matches (default)',
      ).conflicts('loose'),
    )
    .addOption(
      new Option('--loose', 'allow fallback request matching').conflicts(
        'strict',
      ),
    )
    .addOption(
      new Option('--pace <mode>', 'replay timing')
        .choices(['recorded', 'instant'])
        .default('instant'),
    )
    .action(async (tape: string, command: string[], options: ReplayOptions) => {
      process.exitCode = (await replayCommand(tape, command, options)).code;
    });

  program
    .command('fork')
    .description('Replay a prefix and record the live continuation')
    .argument('<tape>', 'source tape')
    .argument('<cmd...>', 'command to run (after --)')
    .option('--at <n>', 'go live from LLM call number n', (value: string) => {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw new InvalidArgumentError('must be an integer >= 1');
      return Number(value);
    })
    .option('--out <path>', 'output tape path (default: <source>.fork.tape)')
    .option('--force', 'overwrite an existing output tape')
    .addOption(
      new Option('--pace <mode>', 'replay timing')
        .choices(['recorded', 'instant'])
        .default('instant'),
    )
    .option('--diff', 'print a diff after the child exits')
    .option('--no-color', 'disable colored output')
    .action(
      async (tape: string, command: string[], options: ForkCommandOptions) => {
        process.exitCode = await forkCommand(tape, command, options);
      },
    );

  program
    .command('diff')
    .description('Compare the behavior of two recorded runs')
    .argument('<a.tape>', 'first tape')
    .argument('<b.tape>', 'second tape')
    .option('--json', 'output a machine-readable diff')
    .option('--tui', 'open the interactive diff viewer')
    .option('--no-color', 'disable colored output')
    .action(async (a: string, b: string, options: DiffOptions) => {
      process.exitCode = await diffCommand(a, b, options);
    });

  program
    .command('show')
    .description('Inspect a recorded tape')
    .argument('<tape>', 'tape to inspect')
    .option('--json', 'output machine-readable data')
    .action(showCommand);

  program
    .command('export')
    .description('Export a tape as OpenTelemetry traces')
    .argument('<tape>', 'tape to export')
    .addOption(
      new Option('--format <format>', 'export format')
        .choices(['otlp-json'])
        .default('otlp-json'),
    )
    .option('--out <file>', 'write to a file instead of stdout')
    .option('--force', 'overwrite an existing output file')
    .option('--endpoint <url>', 'POST traces to an OTLP/HTTP endpoint')
    .option('--include-content', 'include sensitive input and output messages')
    .option('--service-name <name>', 'override the resource service name')
    .action(async (tape: string, options: ExportCommandOptions) => {
      const { exportCommand } = await import('./commands/export.js');
      process.exitCode = await exportCommand(tape, options);
    });

  program
    .command('test')
    .description('Replay each tape and check for drift')
    .argument('<dir|glob>', 'tape directory or glob')
    .argument('<cmd...>', 'command to run (after --)')
    .action(async (input: string, command: string[]) => {
      process.exitCode = await testCommand(input, command);
    });

  return program;
}

# CLI reference

Requires Node ≥20. Put `--` before the child command so its flags are not parsed
as tapediff flags. Paths are relative to the current working directory.

## Commands and flags

These blocks are generated from the built CLI's real `--help` output by
`npm run docs:help` after `npm run build`. Defaults and choices come directly
from Commander. `--verbose` is accepted globally but currently has no effect
on command diagnostics. `help [command]` and `-h` / `--help` exit successfully.

<!-- help:start -->

### Global

```text
Usage: tapediff [options] [command]

Snapshot testing for AI agents.

Options:
  -V, --version                     output the version number
  --verbose                         enable verbose logging
  -h, --help                        display help for command

Commands:
  record [options] <cmd...>         Record an agent’s LLM traffic to a tape
  replay [options] <tape> <cmd...>  Replay a tape deterministically
  fork [options] <tape> <cmd...>    Replay a prefix and record the live
                                    continuation
  diff [options] <a.tape> <b.tape>  Compare the behavior of two recorded runs
  show [options] <tape>             Inspect a recorded tape
  test <dir|glob> <cmd...>          Replay each tape and check for drift
  help [command]                    display help for command
```

### record

```text
Usage: tapediff record [options] <cmd...>

Record an agent’s LLM traffic to a tape

Arguments:
  cmd             command to run (after --)

Options:
  --out <tape>    output tape path (default: "run.tape")
  --name <label>  label for the recording
  --force         overwrite an existing output tape
  -h, --help      display help for command
```

### replay

```text
Usage: tapediff replay [options] <tape> <cmd...>

Replay a tape deterministically

Arguments:
  tape           tape to replay
  cmd            command to run (after --)

Options:
  --strict       require exact request matches (default)
  --loose        allow fallback request matching
  --pace <mode>  replay timing (choices: "recorded", "instant", default:
                 "instant")
  -h, --help     display help for command
```

### fork

```text
Usage: tapediff fork [options] <tape> <cmd...>

Replay a prefix and record the live continuation

Arguments:
  tape           source tape
  cmd            command to run (after --)

Options:
  --at <n>       go live from LLM call number n
  --out <path>   output tape path (default: <source>.fork.tape)
  --force        overwrite an existing output tape
  --pace <mode>  replay timing (choices: "recorded", "instant", default:
                 "instant")
  --diff         print a diff after the child exits
  --no-color     disable colored output
  -h, --help     display help for command
```

### diff

```text
Usage: tapediff diff [options] <a.tape> <b.tape>

Compare the behavior of two recorded runs

Arguments:
  a.tape      first tape
  b.tape      second tape

Options:
  --json      output a machine-readable diff
  --tui       open the interactive diff viewer
  --no-color  disable colored output
  -h, --help  display help for command
```

### show

```text
Usage: tapediff show [options] <tape>

Inspect a recorded tape

Arguments:
  tape        tape to inspect

Options:
  --json      output machine-readable data
  -h, --help  display help for command
```

### test

```text
Usage: tapediff test [options] <dir|glob> <cmd...>

Replay each tape and check for drift

Arguments:
  dir|glob    tape directory or glob
  cmd         command to run (after --)

Options:
  -h, --help  display help for command
```

### help

```text
Usage: tapediff [options] [command]

Snapshot testing for AI agents.

Options:
  -V, --version                     output the version number
  --verbose                         enable verbose logging
  -h, --help                        display help for command

Commands:
  record [options] <cmd...>         Record an agent’s LLM traffic to a tape
  replay [options] <tape> <cmd...>  Replay a tape deterministically
  fork [options] <tape> <cmd...>    Replay a prefix and record the live
                                    continuation
  diff [options] <a.tape> <b.tape>  Compare the behavior of two recorded runs
  show [options] <tape>             Inspect a recorded tape
  test <dir|glob> <cmd...>          Replay each tape and check for drift
  help [command]                    display help for command
```

<!-- help:end -->

## Behavior

- **record**: creates `run.tape` by default; refuses existing files unless
  `--force` is supplied. `--force` removes the existing tape before recording.
  The child uses the local proxy; forwarded traffic can incur provider charges.
- **replay**: strict matching and instant SSE delivery by default. `--strict`
  and `--loose` conflict. `--pace recorded` uses recorded SSE event offsets;
  it does not reproduce initial response latency. Unused calls warn but do not
  alone change replay's exit code. No upstream fallback on a miss.
- **fork**: serves matching recorded requests until the first LLM miss, then
  records live traffic. `--at n` serves the first n-1 LLM calls positionally,
  warning on changed requests and switching early on an endpoint change or
  exhausted prefix. Default output is `<source basename>.fork.tape` beside the
  source; `--force` has record's overwrite semantics. Keys are inherited, never
  replaced with replay placeholders. See [fork](fork.md) for exact semantics.
- **diff**: compares provider-neutral steps. Usage, latency, cost and generated
  tool IDs alone do not count as behavioral changes. Text is a bounded summary;
  `--json` retains full content and takes precedence over `--tui`.
- **show**: displays deduplicated user/system inputs, calls, tools, results,
  assistant text and errors. `--json` emits `{schemaVersion: 1, header, steps,
totals}`. Step `kind` is input, llm_call, tool_call, tool_result, text, or error.
  Totals include calls, inputTokens, outputTokens, tokens, costUsd, latencyMs.
  Missing usage becomes zero; cost is null if any contributing call is unpriced.
- **test**: strictly replays each tape, sequentially, and writes PASS/FAIL rows
  to stderr. A miss, unused exchange, or nonzero child exit fails the suite.
  Directories are searched recursively. Quoted globs support `*`, `?`, character
  classes and `**` directory segments. No matches is an error. There are no
  `test --loose` or `test --update` flags.

Replay, fork and test replace `{tape}` in every child argument with the absolute
tape path and set `TAPEDIFF_TAPE` to it. The agent must select the corresponding
scenario; a filename does not alter requests automatically. Replay and test supply
`tapediff-replay` for unset or empty provider API keys; existing keys are retained.

Text and TUI views render tool-result and assistant content that parses as a JSON
object or array as compact JSON. Changed values use structural field paths, like
tool arguments. Raw `--json` output and exact content comparisons are unchanged;
whitespace/key-order-only changes are labeled as formatting differences in text.
Costs use adaptive precision so nonzero estimates never display as zero; exactly
zero is `$0`, and unpriced calls display `cost unknown`.

### Interactive diff

`--tui` requires TTY stdin and stdout; otherwise it warns and uses text output.
Panes are side by side at ≥100 columns and stacked below that. Ink/React load lazily.

| Key           | Action                                     |
| ------------- | ------------------------------------------ |
| Arrows or j/k | Move; scroll expanded content              |
| PgUp/PgDn     | Move or scroll a page                      |
| g/G           | Top/bottom                                 |
| n/N           | Next/previous difference, wrapping         |
| Enter         | Expand/collapse full content and word diff |
| / or d        | Toggle differences only                    |
| q/Esc         | Quit, preserving the diff exit code        |

### Environment

These are the application-specific environment inputs/outputs and color controls.
The child otherwise inherits its parent's environment and standard streams.

| Variable                              | Meaning                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Read by SDKs; replay/test fill empty values with a placeholder. Record and fork do not.                                                                 |
| `OPENAI_BASE_URL`                     | Record/fork upstream fallback; child receives `http://127.0.0.1:<port>/openai/v1`.                                                                      |
| `OPENAI_API_BASE`                     | Child receives the same OpenAI URL for older clients. Not used to choose the recording upstream.                                                        |
| `ANTHROPIC_BASE_URL`                  | Record/fork upstream fallback; child receives `http://127.0.0.1:<port>/anthropic`.                                                                      |
| `TAPEDIFF_OPENAI_UPSTREAM`            | Record/fork override, before `OPENAI_BASE_URL`; default `https://api.openai.com`.                                                                       |
| `TAPEDIFF_ANTHROPIC_UPSTREAM`         | Record/fork override, before `ANTHROPIC_BASE_URL`; default `https://api.anthropic.com`.                                                                 |
| `TAPEDIFF_REDACT`                     | Comma-separated JavaScript regex sources for additional tape/diagnostic redaction. Invalid patterns are ignored. See [scope](tape-format.md#redaction). |
| `TAPEDIFF_TAPE`                       | Absolute tape path injected into replay/fork/test children.                                                                                             |
| `NO_COLOR`                            | Any defined value, including empty, disables show/diff color.                                                                                           |
| `FORCE_COLOR`                         | Any defined value except `0` enables show/diff color when piped, unless `NO_COLOR` or `--no-color` disables it.                                         |

Without a force override, show/diff enable color only on TTY stdout. Text width
comes from stdout's terminal columns, defaulting to 100; `COLUMNS` is not read.
Other SDK variables (such as `ANTHROPIC_AUTH_TOKEN`) are inherited, not managed.

### Exit codes

| Code       | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 0          | Success; diff has identical behavior; test passed; help/version printed.                                              |
| 1          | Diff found behavioral changes, or test failed.                                                                        |
| 2          | CLI usage/read/setup error, including no matching tapes. Per-tape failures inside test become 1.                      |
| 3          | Replay miss (takes precedence over child exit), or fork proxy failure.                                                |
| Child code | Record/replay/fork propagate child codes unless replay misses or fork proxy fails. These can overlap the codes above. |
| 130 / 143  | Signal-derived child exit for SIGINT / SIGTERM when no numeric child exit is available. Platform behavior can differ. |

Fork `--diff` prints the normal text report after its stderr summary and never
changes the child exit code. `NO_COLOR` and `--no-color` apply as for diff.

A replay miss returns HTTP **500** with `x-should-retry: false` and a JSON
`tapediff_replay_miss` error. Diagnostics go to stderr. Child stdout/stderr pass
through; JSON output from show/diff is on stdout.

# Diff JSON v1

`tapediff diff a.tape b.tape --json` writes one pretty-printed JSON object and a
trailing newline. Exit codes: **0** identical behavior, **1** behavior differs,
**2** usage/read error. Errors go to stderr. `--tui` opens the interactive viewer; non-TTY output falls back to text with a warning. `--json` takes precedence when both flags are supplied.

The machine-readable contract is [diff.v1.json](../schema/diff.v1.json), using JSON
Schema draft 2020-12. Tests validate output with an equivalent strict Zod schema
and compare its generated JSON Schema with that file to prevent drift. Object
keys are serialized in lexical order recursively; array order is meaningful.
Identical inputs produce identical JSON, including recorded metadata. Different
paths, dates, IDs or usage can change JSON without changing behavior.

| Field             | Meaning                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`   | Always `1`.                                                                                                                                                                                                                                                                    |
| `a`, `b`          | `{name, path, createdAt}`. Name is the tape label or `null`; path is exactly the CLI argument; createdAt is the recorded ISO timestamp.                                                                                                                                        |
| `identical`       | True exactly when every aligned operation is `equal` (including empty runs).                                                                                                                                                                                                   |
| `firstDivergence` | `null`, or `{index, a?, b?}`. Index is **zero-based in the aligned ops array**, not either input. Terminal output displays index + 1. Sides contain the original steps; an insertion lacks `a`, a removal lacks `b`.                                                           |
| `ops`             | Ordered alignment operations, described below.                                                                                                                                                                                                                                 |
| `toolCalls`       | `{added, removed, changed}` counts of tool-call operations only; results are not counted again.                                                                                                                                                                                |
| `finalText`       | `{a, b, changed}`. Concatenated text steps following each run's last LLM call; empty string if absent. Partial output before an error is retained; an older response is never substituted.                                                                                     |
| `totals`          | `{a, b, delta}`. Each has `calls`, `inputTokens`, `outputTokens`, `tokens`, `costUsd`, `latencyMs`. Delta is **b − a**. Calls count LLM requests; tokens = input + output. Latency is the sum of recorded call latencies, including concurrent calls, not wall-clock duration. |
| `byModel`         | Array of `{model, a, b}`, with each side `{calls, tokens, costUsd}`. Union of model names, sorted lexically, null first. An absent model has zero totals.                                                                                                                      |

Costs use USD and are `null` if any contributing call has unknown pricing. A cost
delta is `null` if either side is unknown. Empty totals have cost 0. No percentage
fields are serialized; the terminal computes percentage change relative to a,
only when the baseline is positive. Zero deltas show `(no change)`; non-zero cost deltas use adaptive precision.

## Alignment and operations

Myers alignment finds a longest common subsequence of equality keys:
`[kind, tool name]` for tool calls/results, `[kind, model]` for LLM calls, `[kind, role]` for inputs, and kind
alone for text/errors. Unnamed results and unknown models use null in the key.
Parallel calls remain in recorded order. Reorders appear as removals/additions;
repeated keys match deterministically in sequence order. A model substitution
therefore appears as a removed and an added call.

- `equal`: `{type, aIndex, bIndex, a, b}`.
- `changed`: `{type, aIndex, bIndex, a, b, detail}`.
- `removed`: `{type, aIndex, a}`.
- `added`: `{type, bIndex, b}`.

Input indices are zero-based. Steps preserve the provider-neutral `toSteps`
output, including IDs and usage (see the schema for all six step variants).
Matched calls compare model/status only. Tool calls compare JSON arguments;
results compare content and `isError` (absent means false); text compares exact
content; inputs compare exact content after alignment by role; errors compare status/message. Tool IDs, call sequence/provider, usage,
cost and latency do not affect behavior. JSON object key order is ignored; array
order and text whitespace are preserved. Inputs are never mutated.

## Change details

Tool arguments use `{kind: "json", changes: [...]}`; LLM status and error fields
use `{kind: "fields", changes: [...]}`. Each change is `{path, before?, after?}`:

```json
{ "path": "/city", "before": "Paris", "after": "Tokyo" }
```

Paths are JSON Pointers: empty string is the root, `/items/0/name` traverses an
array by index, `~0` escapes `~`, `~1` escapes `/`. Missing sides are **omitted**, so
an added null is `{path: "/value", after: null}`. Object keys are visited in lexical
order. Arrays compare by index, without move detection. Type changes replace
the value at that path.

Inputs/text/results use `{kind: "text", mode, changes, fields}`. Mode is `words` for
single-line text of at most 200 characters on both sides; otherwise `lines`.
`changes` contains `{type: "equal" | "removed" | "added", value: string}` parts
from the `diff` package. A whitespace-only change that `diffWords` ignores falls
back to a full removed/added pair. `fields` contains any result `isError` change;
it is empty for plain text. `finalText.changed` compares exact strings; final
answer change details are available in the text operations.

## Terminal output

Text output is a summary bounded by the terminal width (100 columns when
unavailable); long values may be truncated. JSON retains full content. Equal
runs longer than three steps collapse to a count. Changed inputs and long text
edits show a word-diff window around the first changed region, with `…` for omitted
context and `[-removed-]` / `{+added+}` markers. Short multiline edits use git-style
lines. This display window does not change the JSON detail mode or content.
Tool-result and assistant content that parses as a JSON object/array is displayed
as compact JSON in text and TUI, with structural field changes. The JSON output
retains the original strings and text details. Exact comparisons still detect
formatting-only differences; the text view labels them explicitly.
Added/removed/changed operations are green/red/yellow when color is enabled.
`NO_COLOR` (even empty) and `--no-color` disable ANSI colors. Non-TTY stdout is
plain unless `FORCE_COLOR` is defined with a value other than `0`.

Inputs are `{kind: "input", role: "user" | "system", content: string}`. Request
system/developer messages, Responses instructions, Anthropic system prompts,
and user messages are emitted before their call, once per role + text across
the run. Developer normalizes to system. Non-text blocks are ignored.
Final-response text stays in JSON ops but appears only in the final-answer
section of text output.

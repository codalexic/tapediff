# Tape format v2

`.tape` is UTF-8 JSONL. The first physical line is a header; each later line is
one HTTP exchange or tool record. Readers accept versions 1 and 2; writers emit 2.
The authoritative runtime schema is [src/tape/schema.ts](../src/tape/schema.ts).
Committed [example tapes](../examples/python-openai/tapes) are real files you can inspect.

## Header

| Field       | Type / meaning                                                                      |
| ----------- | ----------------------------------------------------------------------------------- |
| `tapediff`  | `1` or `2`, tape format version; new recordings use `2`.                            |
| `createdAt` | ISO datetime with timezone.                                                         |
| `name`      | Optional recording label.                                                           |
| `command`   | Array of child command/argument strings, redacted before writing.                   |
| `tool`      | `{name: "tapediff", version: string}`; package version, separate from tape version. |

A fork header additionally has optional `forkedFrom`:

`{tape: string, at: number | null, mode: "divergence" | "positional", sourceCreatedAt: string}`.
`tape` is the source path as supplied, redacted before writing. `at` is an integer
≥1 for positional mode, or null for divergence mode. `sourceCreatedAt` copies
the source header's ISO timestamp. `command` identifies the new child command.

## Exchange

| Field            | Type / meaning                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`, `seq`      | Nonnegative integers; recorder assigns arrival sequence starting at zero.                                          |
| `provider`       | `openai`, `anthropic`, or `unknown`.                                                                               |
| `endpoint`       | String beginning `/`, normalized upstream route.                                                                   |
| `request`        | `{method, path, headers, body}`; method nonempty, path begins `/`, headers string map, body any JSON value.        |
| `matchKey`       | 64 lowercase hex characters: SHA-256 [normalized request](matching.md).                                            |
| `response`       | `{status, headers, body?, sse?}`; HTTP status 100–599, headers string map, optional JSON body, optional SSE array. |
| `response.sse[]` | `{t, data}`; nonnegative milliseconds from response start and SSE text.                                            |
| `timing`         | `{startedAt, latencyMs}`; ISO timestamp and nonnegative elapsed milliseconds.                                      |
| `usage`          | Optional `{inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}`; nonnegative integers.                 |
| `model`          | Optional string.                                                                                                   |
| `costUsd`        | Optional nonnegative number or null for unknown pricing.                                                           |
| `aborted`        | Optional boolean marking a client-aborted response.                                                                |

An exchange may also have `servedFrom: {seq: number}`, with a nonnegative source
sequence number. Fork writes the incoming request and recomputes both match keys,
assigns the new run's `id`/`seq` and `timing.startedAt`, and retains the source
response, usage, model, cost and `timing.latencyMs`. Live exchanges omit
`servedFrom`. HTTP exchange records still have no `kind` field; version 1
exchange lines remain valid in version 2. Old tapes read, replay and diff as
before. See [fork semantics](fork.md).

JSON bodies are reserialized on replay. SSE text and offsets are retained after
redaction; redaction can regroup raw network chunks into event frames. This is
not byte-for-byte TCP capture. Upstream HTTP errors are recorded too.

Writes are serialized, appended and fsynced per header/exchange. Exchanges can
finish out of order; readers sort by `seq`. A final EOF-truncated exchange without
a terminating newline is ignored with a warning. Other corruption fails validation;
a crash before an exchange is flushed cannot recover that exchange.

## Tool record

```json
{
  "kind": "tool",
  "id": 1,
  "seq": 1,
  "name": "get_weather",
  "args": { "city": "Paris" },
  "matchKey": "<64 lowercase hex characters>",
  "result": { "temperature": 22 },
  "timing": { "startedAt": "2026-10-09T00:00:00Z", "latencyMs": 3 }
}
```

`id` equals `seq`, the nonnegative integer sequence of the start request,
independent of finish order. The start/finish protocol token is never stored.
`name` is nonempty; `args` and `result` are
JSON values. Exactly one of `result` or `error: {name: string, message: string}`
is present; errors never include stacks. A top-level JavaScript undefined result
is stored as `"result": null, "undefined": true` and replays as undefined. The
optional marker must be true and requires a null result; Python ignores it
and returns None. Nested undefined object properties are omitted and undefined
array elements become null, matching `JSON.stringify`.
`matchKey` is SHA-256 of canonical JSON `{name,args}`, before redaction.
`timing` has the same shape as exchanges, with latency measured start to finish.
Optional `servedFrom: {seq}` identifies the source tool in a fork.

Tools are durably appended on finish. Unfinished starts produce no record and
one shutdown warning. Readers sort exchanges and tools separately by sequence
and return `{header, exchanges, tools}`. Version 1 fixtures have an empty tools
array. `show` merges the timelines; step diff continues to use only exchanges.
See [tool semantics and protocol](tools.md).

## Redaction

Before writing, tapediff applies these protections to its tapes:

- Headers use an allowlist: `content-type`, `anthropic-version`, `anthropic-beta`,
  `openai-beta`, `x-request-id`, `request-id`, `retry-after`, and `x-ratelimit-*`.
  Names matching `/key|token|secret/i` are always excluded. Authorization,
  cookies, API keys and `openai-organization` headers are excluded.
- String values and object keys are scrubbed for `sk-[A-Za-z0-9_-]{16,}`,
  `sk-ant-[A-Za-z0-9_-]+`, and Bearer credentials. Matches become `[REDACTED]`.
- String values of credential properties are replaced wholesale: API-key
  variants, `secret`, `client_secret`/`client-secret`, `password`, `passwd`,
  access/refresh/auth token variants, `authorization`, and `bearer` (case-insensitive).
- `TAPEDIFF_REDACT` adds comma-separated regex sources, applied globally.
  Empty or malformed regexes are ignored; built-in scrubbing remains active.
  Commas are separators even inside a regex. Use trusted, bounded patterns.
- Tool arguments, results and error messages use these same body rules.
  Their match keys are computed before redaction.
- SSE JSON events receive property redaction, then string redaction across each
  whole event. A secret split across chunks within one event can be scrubbed;
  a secret split across separate delta events is not guaranteed to be detected.

This is **not** general secret detection or anonymization. Names, addresses,
proprietary prompts, arbitrary credential formats and sensitive tool data may
remain. Review every tape before sharing it. Child stdout/stderr is inherited
unchanged; tapediff cannot redact what your agent logs. Never put keys in CLI
arguments. Keep credentials in environment variables.

Matching hashes are computed from the original normalized request. Scrubbing
response values can change later conversation history, and loose matching uses
the stored redacted request body. Secret-bearing conversations may therefore
miss on replay; use synthetic inputs when creating shareable fixtures.

## Versioning

Zod validates records when reading and writing. Versions `1` and `2` are supported;
writers always emit `2`. Version `3` or newer asks you to upgrade; versions below `1` ask you to
re-record. There is no tape migration command. Tape version and the
[diff JSON `schemaVersion`](diff-json-schema.md) are independent contracts.

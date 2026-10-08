# Tape format v1

`.tape` is UTF-8 JSONL. The first physical line is a header; each later line is
one exchange. The authoritative runtime schema is [src/tape/schema.ts](../src/tape/schema.ts).
Committed [example tapes](../examples/python-openai/tapes) are real files you can inspect.

## Header

| Field       | Type / meaning                                                                      |
| ----------- | ----------------------------------------------------------------------------------- |
| `tapediff`  | Literal `1`, tape format version.                                                   |
| `createdAt` | ISO datetime with timezone.                                                         |
| `name`      | Optional recording label.                                                           |
| `command`   | Array of child command/argument strings, redacted before writing.                   |
| `tool`      | `{name: "tapediff", version: string}`; package version, separate from tape version. |

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

JSON bodies are reserialized on replay. SSE text and offsets are retained after
redaction; redaction can regroup raw network chunks into event frames. This is
not byte-for-byte TCP capture. Upstream HTTP errors are recorded too.

Writes are serialized, appended and fsynced per header/exchange. Exchanges can
finish out of order; readers sort by `seq`. A final EOF-truncated exchange without
a terminating newline is ignored with a warning. Other corruption fails validation;
a crash before an exchange is flushed cannot recover that exchange.

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

Zod validates records when reading and writing. Version `1` is the only supported
tape version. A newer version asks you to upgrade; an older one asks you to
re-record. There is no tape migration command. Tape version and the
[diff JSON `schemaVersion`](diff-json-schema.md) are independent contracts.

# Design notes

Record an agent's LLM traffic, replay stored responses without provider calls,
and diff two runs to see where behavior diverged. The child still executes.

## CLI

```
tapediff record [--out run.tape] [--name <label>] -- <cmd...>
tapediff replay <tape> [--strict|--loose] [--pace recorded|instant] -- <cmd...>
tapediff fork <tape> [--at n] [--out fork.tape] [--diff] -- <cmd...>
tapediff diff <a.tape> <b.tape> [--json] [--tui] [--no-color]
tapediff show <tape> [--json]
tapediff export <tape> [--out traces.json] [--endpoint url] [--include-content]
tapediff test <dir|glob> -- <cmd...>       # replay each tape; non-zero exit on any miss/drift
```

Exit codes: 0 ok, 1 diff found / test drift, 2 usage error, 3 replay miss, child's exit code is propagated by record/replay when non-zero.

## Interception

- Local HTTP proxy on 127.0.0.1, random free port.
- `record`/`replay`/`fork`/`test` spawn the child with env vars pointing SDKs at the proxy:
  `OPENAI_BASE_URL=http://127.0.0.1:<port>/openai/v1`, `OPENAI_API_BASE` (same), `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic`, and `TAPEDIFF_PROXY_URL=http://127.0.0.1:<port>` for opt-in tool helpers.
- Upstreams: default `https://api.openai.com` and `https://api.anthropic.com`; override via `TAPEDIFF_OPENAI_UPSTREAM` / `TAPEDIFF_ANTHROPIC_UPSTREAM` (tests use a local fake upstream). If the user already set `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, use that as upstream.
- Supported endpoints: OpenAI `/v1/chat/completions`, `/v1/responses`; Anthropic `/v1/messages`. Other paths under a provider prefix are forwarded in record mode and recorded generically; unprefixed unknown routes return a recorded 404.
- Streaming SSE: record raw chunks with relative timestamps (ms). Replay emits chunks instantly by default, or at recorded pace with `--pace recorded`.
- Must handle: concurrent requests, upstream errors (4xx/5xx recorded and replayed faithfully), client abort, child exit, Ctrl-C (proxy + child cleaned up, tape flushed).
- Windows, macOS, Linux.

## Tape format (`.tape`, JSONL, UTF-8)

Line 1 header: `{"tapediff":2,"createdAt":ISO,"name"?,"command":[...],"tool":{"name":"tapediff","version":...}}`
Readers accept versions 1 and 2; writers always emit 2. Each subsequent line is
an HTTP exchange (unchanged, with no kind field) or a `kind: "tool"` record:

```
{"id":n,"seq":n,"provider":"openai"|"anthropic"|"unknown","endpoint":"/v1/messages",
 "request":{"method","path","headers"(allowlisted, redacted),"body"},
 "matchKey":"sha256...",
 "response":{"status","headers"(allowlisted),"body"?|"sse"?:[{"t":ms,"data":string}]},
 "timing":{"startedAt","latencyMs"},
 "usage":{"inputTokens","outputTokens","cacheReadTokens"?,"cacheWriteTokens"?}?,
 "model"?, "costUsd"?}
```

- Tool records contain `{kind:"tool", id, seq, name, args, matchKey, result? | error?:{name,message}, timing:{startedAt,latencyMs}, servedFrom?:{seq}}`. Exactly one of result/error is present. Sequence is assigned at start; latency spans start to finish. Unfinished tools warn once and write nothing.
- `readTape` returns `{header, exchanges, tools}` separately. Tools are strictly matched by SHA-256 of canonical `{name,args}`, with FIFO queues. Redaction covers args, results and error messages; hashes use unredacted inputs. Reserved `/tapediff/v1/` traffic never reaches providers or exchange records. See [the tool protocol](tools.md).
- Validate with zod; tape version mismatch → clear error.
- Redaction is mandatory: `authorization`, `x-api-key`, `api-key`, `openai-organization`, `cookie`, and anything matching `/key|token|secret/i` in headers is never written. Also scrub body strings matching `sk-[A-Za-z0-9_-]{16,}` and `sk-ant-...`. Extra patterns via `TAPEDIFF_REDACT` (comma-separated regexes).
- Writes are append + flush per exchange so a crash still leaves a valid partial tape.

## Replay matching

- `matchKey` = sha256 of canonical JSON of {method, path, normalized body}. Normalization: sort keys; drop `user`, `metadata`, `stream_options`, `store`, `service_tier`, `seed`(loose only), request ids.
- Exchanges with identical keys are consumed in recorded order (queue per key).
- `--strict` (default): unmatched request → HTTP 500 with retries disabled, print a redacted diff against the nearest unused request at that endpoint, and exit 3 after the child finishes.
- `--loose`: if no exact match, fall back to next unconsumed exchange with same endpoint+model in order, warn.

## Steps model (provider-neutral)

`Step = input{role: "user"|"system", content} | llm_call{model, inputTokens, outputTokens, costUsd, latencyMs} | tool_call{id, name, args} | tool_result{id, name?, content, isError?} | text{content} | error{status, message}`

- input from request user messages and system prompts (OpenAI system/developer, Responses instructions, Anthropic top-level system). Normalize developer to system; dedupe by role + text across the run. Text blocks are concatenated; non-text blocks are ignored.
- tool_call from response (OpenAI `tool_calls` / Responses `function_call` items; Anthropic `tool_use` blocks), including parallel calls and streamed (reassembled from SSE deltas).
- tool_result from the _next_ request's messages (OpenAI `role:"tool"`, Responses `function_call_output`; Anthropic `tool_result` blocks), deduped so each result appears once.
- final text = text of the last assistant response.

## Diff

- Align step sequences (Myers/LCS) with equality keys `(kind, name)` for tools, `(kind, role)` for inputs, `(kind, model)` for calls, and kind for text/errors; matched pairs compared deeply (JSON arg diff, text diff).
- Report: first divergence index, added/removed/changed tool calls, final-answer diff, totals delta (calls, tokens, cost, latency), per-model breakdown.
- Renderers: colored text (default, respects NO_COLOR / non-TTY; explicit FORCE_COLOR enables piped captures unless NO_COLOR or --no-color disables it), `--json` (stable, documented schema with `"schemaVersion":1`), `--tui` (Ink side-by-side, keyboard nav). Changed inputs and long text changes use a word-diff window around the first changed region, with ellipses for omitted context; JSON retains full content.
- TUI: aligned panes, stacked below 100 columns; arrows/j/k, PgUp/PgDn, g/G, n/N, Enter to expand full content with word diff, / or d to filter differences, q/Esc to quit. Expanded content scrolls. Non-TTY stdout or stdin falls back to text with a warning; JSON takes precedence. Ink/React load lazily.
- Exit 1 if behavior differs (any non-equal step), 0 if identical.

## Fork

`fork` reruns a command, serves a recorded prefix, then records live traffic.
Strict divergence matching switches permanently on the first LLM or wrapped tool miss;
`--at n` instead assigns the first n-1 LLM responses by request arrival order.
Response serving and upstream recording share replay/record implementations.
Optional provenance fields identify the source and served exchanges and tools;
diff ignores that provenance. Wrapped tools replay until the live boundary;
unwrapped tools execute live. See [Fork](fork.md) for
ordering, changed-prefix warnings, credentials, output and exit semantics.

## OpenTelemetry export

`tapediff export` reconstructs one deterministic trace from a tape, with an
INTERNAL root, CLIENT model exchanges, and INTERNAL recorded tools. The pure
`src/export/otlp.ts` mapper emits OTLP/JSON without an SDK or runtime dependency;
`src/commands/export.ts` handles stdout, exclusive file output and explicit HTTP
delivery. It reuses step output and SSE reassembly. Content capture is opt-in,
and tool call IDs are linked only when unambiguous. Diff and replay remain local
tape operations. See [the mapping and specification reference](otel.md).

## Pricing

`src/pricing.json`: `{ "<model-prefix>": {"input": usdPer1M, "output": usdPer1M, "cacheRead"?, "cacheWrite"?} }`, longest-prefix match; unknown model → cost null, never crash.

## Tradeoffs

- **HTTP proxy, not SDK patches or framework callbacks.** The base-URL boundary
  works the same for every SDK and framework that honors it, in any language.
  Patching or callbacks could see richer runtime state, but would couple capture
  to specific library versions. The cost: the proxy can't see local computation
  or memory.
- **Opt-in tool recording.** A tool call in a model response doesn't prove the
  tool ran, what side effects it had, or what it actually returned. A wrapper
  marks that boundary explicitly instead of guessing.
- **Two fork modes.** Divergence mode finds the first request that changed.
  Positional mode deliberately reuses responses even though the prefix prompts
  changed. That's what makes "fix call #3, keep #1-#2" possible, and it's why
  fork warns about every changed request it serves.
- **Deliberately not done:** process snapshots, durable execution, framework
  state restore.

When something else is the better tool:

- [LangGraph checkpoints and time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)
  resume or edit graph state at a saved checkpoint, inside LangGraph.
- [Temporal-style durable execution](https://docs.temporal.io/workflow-execution)
  rebuilds workflow state from event history, for recovering long-lived workflows.
- [vcrpy](https://vcrpy.readthedocs.io/en/latest/) and
  [Polly.js](https://netflix.github.io/pollyjs/) are general HTTP cassettes for
  their test runtimes.

tapediff's niche is provider-aware timelines, behavior diffs, and a live
continuation from any recorded call, independent of framework and language.

## Non-goals

No hosted service, no telemetry, no SDK monkeypatching, no HTTPS MITM.

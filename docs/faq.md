# FAQ

## Is this an agent framework or hosted service?

Neither. It is a local CLI and loopback proxy. There is no account, hosted backend
or telemetry in tapediff. Recording sends requests to your configured provider;
replay reads a local tape. Your SDK and agent may have their own network behavior.

## Is replay free and offline?

The replay proxy does not contact a provider, so replayed LLM calls incur no API
charge. Your process and unwrapped tools still run; they may call external
services that cost money or need network access. [Wrapped tools](tools.md)
serve recorded results without execution. Package installation is separate
from replay.

## Which SDKs have been checked?

Environment-variable support was checked in all four official client implementations:

| Client           | Variable             | Evidence / verification scope                                                                                                                                                |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai-python    | `OPENAI_BASE_URL`    | [Client source](https://github.com/openai/openai-python/blob/main/src/openai/_client.py); bundled trip example uses pinned 1.109.1 and runs against a local mock and replay. |
| openai-node      | `OPENAI_BASE_URL`    | [Client source](https://github.com/openai/openai-node/blob/master/src/client.ts); installed source and local e2e OpenAI agents.                                              |
| anthropic-python | `ANTHROPIC_BASE_URL` | [Client source](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_client.py); source verification, not a Python Anthropic end-to-end test.         |
| anthropic-node   | `ANTHROPIC_BASE_URL` | [Client source](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts); pinned 0.132.1 streaming example against a local mock and replay.           |

These clients consult the environment when no explicit base URL overrides it.
This does not certify every SDK version, endpoint, or cloud-specific subclass.
The [LangGraph example](../examples/python-langgraph/README.md) tests pinned
LangGraph and `langchain-openai` through the same HTTP boundary, including
wrapped tools and fork. LlamaIndex remains untested.

## Does fork restore my agent's memory/state?

No. Fork starts the command again, serves recorded responses for a prefix, then
records live requests. Local computation still runs and rebuilds state; wrapped
tools supply stored JSON results. Process memory, files, databases, and framework
checkpoints are not restored. Use your framework's persistence mechanism when
you need checkpoint recovery. See [fork caveats](fork.md#caveats).

## Do I have to wrap my tools?

No. HTTP recording and replay work without wrappers. Unwrapped tools execute
normally on every run, including replay and a fork's served prefix, so they may
need network access or repeat side effects. Wrapping opts into recording JSON
results and skipping execution during replay. A replayed result does not recreate
files or other side effects that later code might need. See [tools](tools.md).

## Can I view runs in Jaeger/Langfuse/Phoenix?

Yes, via `tapediff export run.tape --endpoint <OTLP/HTTP URL>`, or export a JSON
file for later ingestion. Jaeger has a [verified walkthrough](otel.md#try-it-with-jaeger);
Langfuse and Phoenix may need a collector, authentication, or backend-specific
configuration and have not been checked end-to-end here. GenAI views vary.
Export preserves original timestamps; widen the viewer's time range. Content is
off by default and requires `--include-content`. It reconstructs a trace after
the run; replay and behavior diff remain in tapediff. See [limitations](otel.md#limitations).

## What counts as drift?

`diff` compares aligned inputs, model/status, tool arguments/results, text and
errors. Generated tool IDs and cost/token/latency changes alone do not fail a diff.
`test` checks replay misses, unused exchanges and the child exit code. It does not
capture a second tape or compare stdout. See [matching](matching.md) and
[the JSON contract](diff-json-schema.md).

## Why is an identical answer still a failing diff?

An agent can arrive at the same answer through different prompts, tools or model
calls. The example regression adds an unnecessary weather call. Behavioral steps
are compared, not just the final answer; no LLM judge is used.

## Can I use an existing gateway?

Record uses `TAPEDIFF_OPENAI_UPSTREAM` / `TAPEDIFF_ANTHROPIC_UPSTREAM` first,
then the corresponding SDK base URL, then the official host. A trailing `/v1`
is overlapped once when appending a `/v1/...` route. This is not general support
for Azure OpenAI, Bedrock or arbitrary provider path conventions. Explicitly
hardcoded client URLs bypass interception. There is no HTTPS MITM.

## Are tapes safe to publish?

Only after review. [Redaction](tape-format.md#redaction) removes known credential
patterns and excludes sensitive headers; it does not anonymize prompts, tool data
or responses. Child output is not filtered. Use synthetic fixtures for public bugs.

## Why is a text diff abbreviated?

Terminal output fits the terminal width (100 columns when piped). Changed inputs
and long text edits show a word-diff window around the first changed region, with
ellipses for omitted context. Other long values can be truncated. Use `--json`
for all details or `--tui` in a terminal for expandable content.

## Why are cost or timing numbers surprising?

Prices use longest-prefix matching in [pricing.json](../src/pricing.json) and
are best-effort estimates. Unknown pricing produces null cost. Latency totals
sum recorded calls, including overlapping calls; they are not wall-clock runtime.

## Why does replay pass but test fail?

Replay warns about recorded calls never requested; test fails on them. An early
successful child exit can leave unused tape entries. See [exit codes](cli.md#exit-codes).

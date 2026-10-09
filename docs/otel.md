# Export to OpenTelemetry

Bring recorded runs into Jaeger, Grafana Tempo, Phoenix, Langfuse, or another
OTLP/HTTP backend. Use its trace viewer to inspect timing and model usage alongside
your existing telemetry; behavioral comparison and replay stay in tapediff.
Export is explicit and sends nothing unless you supply `--endpoint`.

## Usage

```sh
tapediff export run.tape
tapediff export run.tape --format otlp-json --out traces.json
tapediff export run.tape --out traces.json --force
tapediff export run.tape --endpoint http://localhost:4318
tapediff export run.tape --out traces.json --endpoint http://localhost:4318
tapediff export run.tape --include-content --service-name weather-agent
```

`otlp-json` is currently the only format and the default. With neither destination,
the JSON body goes to stdout. File and endpoint exports keep stdout empty.
Files are created exclusively with mode `0600` where supported. Existing files
require `--force`; as with `record`, force unlinks the output before creating it,
including a symlink itself rather than its target. Read/validation happens first.
When both destinations are supplied, the file is written before sending; a failed
send leaves that file available for inspection or retry.

An endpoint with an empty path or `/` receives `/v1/traces`; an explicit path is
preserved, as are query parameters. Supply HTTP or HTTPS URLs. URL credentials
and fragments are rejected; use `OTEL_EXPORTER_OTLP_HEADERS` for authentication:

```sh
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20YOUR_TOKEN,x-project=demo'
tapediff export run.tape --endpoint https://collector.example.com/v1/traces
```

Headers are comma-separated `key=value` entries with surrounding whitespace
trimmed; values are percent-decoded, and may contain `=`. Percent-encode literal
commas and percent signs. Empty entries are ignored; malformed entries are usage
errors. Content-Type is always `application/json`. Environment headers are only
read when sending. The endpoint is explicitly supplied, not read from the
environment. Redirects are not followed, so headers cannot be forwarded to a new
destination. There is one POST, a 10-second timeout, and no retry. Any 2xx is
accepted; response bodies, endpoint URLs and headers are never printed.

Exit codes: **0** success, **2** usage/read/file/configuration error, **1** failed
send (including HTTP rejection, redirect, connection failure or timeout).

## Specification reference

Reviewed **2026-10-09** against the current OpenTelemetry
[GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), whose
published pages now redirect readers to the separate
[GenAI repository at revision `06ec68e722c45a7218e23ea1bc1339fe4e21ecae`](https://github.com/open-telemetry/semantic-conventions-genai/tree/06ec68e722c45a7218e23ea1bc1339fe4e21ecae).
The relevant definitions are
[client inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/06ec68e722c45a7218e23ea1bc1339fe4e21ecae/docs/gen-ai/client-inference.md),
[spans and content](https://github.com/open-telemetry/semantic-conventions-genai/blob/06ec68e722c45a7218e23ea1bc1339fe4e21ecae/docs/gen-ai/gen-ai-spans.md),
[agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/06ec68e722c45a7218e23ea1bc1339fe4e21ecae/docs/gen-ai/gen-ai-agent-spans.md), and
[OpenAI](https://github.com/open-telemetry/semantic-conventions-genai/blob/06ec68e722c45a7218e23ea1bc1339fe4e21ecae/docs/gen-ai/openai.md).
These GenAI conventions are still **Development**, with shared semantic
conventions pinned there to **1.44.0**. In particular, this export uses
`gen_ai.provider.name`, not the former `gen_ai.system`. The supported inference
APIs use `chat`, including creation through the Responses API; `responses` is an
API type, not an operation name.

Encoding follows [OTLP 1.11.0, JSON Protobuf Encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding):
lowerCamelCase fields, hex trace/span/parent IDs, numeric enums, decimal strings
for 64-bit integers, `intValue` for integer attributes, `doubleValue` for cost,
and `arrayValue.values` for arrays. The envelope is an
`ExportTraceServiceRequest` with `resourceSpans → scopeSpans → spans`.

## Mapping

| Tape data                             | Export                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One tape                              | One trace and one root INTERNAL span (`kind: 1`), named after header `name`, otherwise the joined command, otherwise `tapediff`. A tape does not identify a framework agent invocation, so the root does not claim `invoke_agent`.                                                                                                                                            |
| Header name and format                | Root `tapediff.tape.name` when present and `tapediff.tape.version`.                                                                                                                                                                                                                                                                                                           |
| Header `forkedFrom`                   | Root `tapediff.forked_from.tape`, `.mode`, `.source_created_at`, and `.at` when non-null.                                                                                                                                                                                                                                                                                     |
| Run totals                            | Root `tapediff.usage.input_tokens`, `.output_tokens`, `.total_tokens`, and `tapediff.cost_usd`. Totals use the same accounting as `show`, excluding unknown-provider traffic. Unknown total cost is omitted.                                                                                                                                                                  |
| Service                               | Resource `service.name`: `--service-name`, header name, then `tapediff`.                                                                                                                                                                                                                                                                                                      |
| Exporter                              | Resource `telemetry.sdk.name=tapediff`, `.language=nodejs`, `.version` is the exporting package version; scope name `tapediff` and the same version (not the recorder version).                                                                                                                                                                                               |
| Supported LLM exchange                | CLIENT span (`kind: 3`), `chat {request model}` or `chat` when unavailable; `gen_ai.operation.name=chat`, `gen_ai.provider.name=openai` or `anthropic`.                                                                                                                                                                                                                       |
| Models                                | `gen_ai.request.model` from the request, falling back to recorded `model`; `gen_ai.response.model` only when stated in JSON or SSE.                                                                                                                                                                                                                                           |
| Usage and cost                        | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `tapediff.cost_usd` when known. Recorded accounting takes precedence, with shared provider extraction/pricing as fallback. Cost is an estimate and is not a GenAI semantic attribute.                                                                                                                           |
| Response metadata                     | `gen_ai.response.id` and array `gen_ai.response.finish_reasons` when available. Chat choice reasons and Anthropic stop reasons are retained; Responses terminal status maps completed to `stop`, failed/cancelled to `error`, incomplete `max_output_tokens` to `length`, otherwise the recorded incomplete reason. SSE uses the existing event parser and output reassembly. |
| Upstream host                         | No `server.address` or `server.port`: tape v1/v2 retain paths, not the upstream origin. Provider defaults or export-time environment variables would not establish the recorded server.                                                                                                                                                                                       |
| HTTP failure / aborted exchange       | Span status ERROR (`code: 2`), `error.type` is the HTTP status string for status ≥400, or `aborted` (takes precedence). No error message/body in the status. Other statuses remain UNSET (`code: 0`).                                                                                                                                                                         |
| Unknown-provider exchange             | CLIENT span named `{METHOD} {endpoint}`, with `http.request.method` and `http.response.status_code`; failures also get status/error type. No GenAI attributes or content.                                                                                                                                                                                                     |
| Recorded v2 tool                      | INTERNAL `execute_tool {name}`, `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`; `gen_ai.tool.call.id` only for a unique one-to-one preceding call with matching name and canonical arguments. Tool failures get ERROR and `error.type` from the recorded error name (fallback `Error`).                                                                             |
| Served exchange/tool                  | `tapediff.served_from_seq`; unknown-provider spans retain only their HTTP/error attributes.                                                                                                                                                                                                                                                                                   |
| Unrecorded or unlinked requested tool | Minimal `gen_ai.tool.call` event on the requesting chat span, at its end, with `gen_ai.tool.name` and call ID when available. No invented execution span, duration, arguments or result.                                                                                                                                                                                      |
| `--include-content`                   | JSON strings in `gen_ai.input.messages`, `gen_ai.output.messages`, and separate `gen_ai.system_instructions` when present, following the conventions' role/parts structure. Text and tool call/result parts are supported; output choices remain separate.                                                                                                                    |

All child spans are direct children of the root and ordered by record `seq`.
Each starts at `timing.startedAt` and ends at start plus `latencyMs`, with
nanosecond timestamps encoded as strings. Timestamp fractions retain up to nine
decimal places; latency is rounded to the nearest nanosecond. The root covers the
earliest start through the latest end, including concurrent tools and exchanges.
An empty tape has a zero-duration root at header `createdAt`. Root status stays
UNSET: tapes do not store the command's exit status, and a failed call may recover.

For Anthropic exchanges, `gen_ai.usage.input_tokens` includes cache-read and
cache-write tokens in addition to the recorded input count, as required by the
[Anthropic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/06ec68e722c45a7218e23ea1bc1339fe4e21ecae/docs/gen-ai/anthropic.md).
OpenAI input counts already include cache tokens and are not increased. The
root's custom totals retain `show`'s accounting, so they can differ from the sum
of GenAI input attributes for Anthropic cached requests.

## Determinism

Sort all exchange and tool records by sequence, join their `matchKey` strings
with no separator, and prepend header `createdAt`. The trace ID is the first
32 lowercase hex characters of SHA-256 of that UTF-8 string. Child span IDs are
the first 16 hex characters of SHA-256 of `traceId + decimal seq + kind`, where
kind is `exchange` or `tool`. The root uses reserved sequence `-1` and kind `root`.

Re-exporting the same tape gives the same IDs, making exports idempotent in
identity; backend storage/deduplication behavior still varies. With the same
package version and options the JSON bytes are identical. Service name and
content options do not change IDs. This is content-derived identity, not a
globally unique recording UUID: tapes with identical header time and match keys
share a trace ID even if their responses differ. Distinct records must have
distinct sequence numbers, as assigned by the recorder.

## Content capture and privacy

Message content is **off by default**. `--include-content` opts into prompt,
response, system instruction and message-level tool content. Recorded tool span
arguments/results and error messages are not exported separately. Names, model
IDs, tool IDs, tape labels, root command names and fork source paths are metadata
and may still be sensitive without the flag.

Tapes are already redacted, but **redaction is not anonymization**. Review the tape
and exported JSON before sharing or uploading. No extra redaction is applied
during export. Authentication headers are only used for transport and are never
added to the exported trace. This exporter does not print response bodies or
credentials on errors.

## Limitations

- This reconstructs a trace after the run: no live propagation, remote parent,
  framework nesting, metrics, logs, or automatic SDK instrumentation.
- A tool event is a minimal requested-call summary, not a claim of execution or
  a complete standardized GenAI event payload. Ambiguous matches keep the event
  and omit the tool span's call ID; duplicate names/arguments are not guessed.
- Content follows the existing text/tool reassembly support. Binary attachments,
  images, reasoning, and unsupported message parts are omitted. Incomplete streams
  can have partial output and missing metadata. Missing usage follows `show`'s
  zero fallback; it is not a measured zero.
- HTTP 200 stream error frames do not alone set ERROR unless the exchange is
  marked aborted; the status mapping uses recorded HTTP status and abort state.
- All 2xx responses count as success, including a backend partial-success reply;
  the response body is not inspected. Backend content limits, retention windows,
  auth requirements and GenAI UI conventions vary. Some products may need an
  OpenTelemetry Collector or backend-specific ingestion configuration.
- Original timestamps are preserved. Old tapes may fall outside a viewer's
  default time range. Recorded/forked cost is an estimate of model usage, not the
  amount newly billed during a served prefix.

## Try it with Jaeger

Open <http://localhost:16686> and select the tape's service name after starting
Jaeger and exporting a tape:

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.22.0
tapediff export run.tape --endpoint http://localhost:4318
```

Recorded timestamps are in the past. Widen the UI's lookback to **Last 7 days**
or choose a custom range covering the recording when viewing older tapes.

Export and trace retrieval were verified with `jaegertracing/jaeger:2.22.0`
using `examples/ts-anthropic/tapes/paris.tape`: six spans (one root, three chat,
and two `execute_tool` spans), with linked tool call IDs and GenAI attributes.

Optionally, query Jaeger's v3 HTTP API. List services at
`http://localhost:16686/api/v3/services`, then retrieve traces with
`http://localhost:16686/api/v3/traces?query.service_name=<svc>&query.start_time_min=...&query.start_time_max=...`.
Replace `<svc>` with the URL-encoded service name and supply time bounds
bracketing the recording. Jaeger 2.x does not serve the
legacy `/api/traces` endpoint.

Stop the foreground Docker command with Ctrl+C when finished; `--rm` removes it.

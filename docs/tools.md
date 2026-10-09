# Recording tools

Wrap tools to replay their results without network calls, clocks, file writes,
or other side effects. Unwrapped tools continue to execute normally. The agent
process still runs; this does not restore its memory or filesystem.

## TypeScript and JavaScript

Install `tapediff` in your agent project. Node.js 20 or later is required.
The `tapediff/tools` entry has no runtime dependencies and uses global `fetch`.
It supports ESM, CommonJS (`require('tapediff/tools')`), and TypeScript.

```ts
import { tool, wrapTool } from 'tapediff/tools';

const weather = await tool('get_weather', { city }, (args) =>
  getWeather(args.city),
);
const getWeatherTape = wrapTool('get_weather', (args: { city: string }) =>
  getWeather(args.city),
);
const forecast = await getWeatherTape({ city: 'Paris' });
```

Both helpers return a Promise of the function's awaited return type. Without
`TAPEDIFF_PROXY_URL`, the helper calls the original function, preserving its
return value and thrown error. This path performs only the environment lookup
and the call, with the Promise required by the API; it does no JSON work or I/O.

With the proxy enabled, arguments and results must be JSON data. A top-level
`undefined` result replays as `undefined`. Nested values follow `JSON.stringify`:
undefined object properties are dropped and undefined array elements become null.
Functions, BigInt, symbols,
cycles and non-finite numbers throw a clear TypeError without writing a tool
record. A recorded success returns the original value; a replay returns a fresh
JSON value. A recorded exception preserves the original thrown error in the
recording process. Only its name and message are stored, never its stack.
Replay throws an Error with that name and message and `tapediffReplayed = true`.
A missing recording throws the exported `TapediffToolMissError`.

If recording an error fails, the helper warns once and rethrows the original
tool error. If the finish request fails after a successful tool, the helper
prints `tapediff: could not record result of tool X; the tape will be missing it`
and returns the real result. A missing recording fails later as a replay miss.
Runtimes without `process` use the direct-call path.

## Python

Copy [tapediff_tools.py](../clients/python/tapediff_tools.py) next to your agent.
This is a vendored, standard-library-only file for Python 3.9+, using urllib
for HTTP. It is not included in the npm package and needs no pip installation.

```python
from tapediff_tools import tool, recorded_tool

weather = tool("get_weather", {"city": city}, lambda args: get_weather(args["city"]))

@recorded_tool(name="get_weather")
def weather_for(city):
    return get_weather(city)

forecast = weather_for(city="Paris")
```

Decorated functions take keyword arguments. Omitting `name` uses the function's
name. Without the proxy variable, values and exceptions pass through unchanged.
Replay raises `TapediffToolError(name, message)` for recorded errors, exposing
`.name`, `.message` and `.tapediff_replayed`, and `TapediffToolMiss` for missing recordings.
Python functions are synchronous. Return JSON data; non-finite numbers and
unsupported values raise TypeError. Use string keys and interoperable JSON
numbers when sharing tapes across languages.
HTTP requests use a 30-second timeout. As in JavaScript, the original tool error
wins if recording that error also fails, with a one-line stderr warning.
A failed finish after success warns and returns the real result too. Python
ignores the undefined marker and returns `None` for its null result.

## Modes and matching

- **Record:** execute the function, then record its result or error.
- **Replay and test:** serve recorded results and errors, skipping the function.
  Match SHA-256 of `canonicalJson({name, args})`: recursively sort object keys,
  preserve array order and all argument fields. Equal keys form FIFO queues in
  start order; each record is consumed once. Distinct keys may arrive out of
  order. Tools always match strictly, even with `replay --loose`.
- **Fork:** while the LLM side has not gone live, serve strictly matching tools
  and copy them to the output tape with new sequence/timestamp and
  `servedFrom: {seq}`. In divergence mode, a tool miss permanently switches both
  tools and LLM calls live. In positional mode, an unmatched tool runs and is
  recorded without switching; once LLM call `--at N` arrives, every subsequent
  tool runs live. `--at 1` starts live, including tools before the first LLM call.

A replay tool miss returns HTTP 409 and prints a redacted unified argument diff
against the nearest unused tool with the same name (shared canonical JSON
lines, with ties in recorded order). Misses make replay exit 3 and `test` fail.
Unused tools also fail `test`; replay reports them separately and warns.
Fork summaries report served and live tools separately from LLM calls.

## Protocol

The child of record, replay, fork, or test receives
`TAPEDIFF_PROXY_URL=http://127.0.0.1:<port>`. Without it, clients call directly.
Only root `/tapediff/v1/` routes are reserved; `/openai/tapediff/v1/...` and
`/anthropic/tapediff/v1/...` are ordinary provider traffic. Reserved routes are
never forwarded upstream and never
recorded as HTTP exchanges or counted as LLM calls or unknown traffic.

1. Send `POST /tapediff/v1/tools/start` with JSON `{ "name": "get_weather",
"args": { "city": "Paris" } }`. `name` is a nonempty string and `args` is
   any JSON value, including null.
2. HTTP 200 returns one of:
   - `{"action":"run","id":"<opaque>"}`: execute the function, then finish.
   - `{"action":"replay","result":<JSON>}`: return the value without execution.
   - `{"action":"replay","error":{"name":"Error","message":"..."}}`:
     raise the recorded error without execution.
3. After `run`, send `POST /tapediff/v1/tools/finish` with either
   `{"id":"<opaque>","result":<JSON>}` or
   `{"id":"<opaque>","error":{"name":"Error","message":"..."}}`.
   Exactly one of result or error is required. Success returns HTTP 204 after
   the record is flushed. Never include a stack in the error object.
   A JavaScript undefined result uses `{"id":"<opaque>","result":null,"undefined":true}`;
   replay replies include the same `result` and `undefined` fields. The optional
   marker must be `true` and requires a null result.

Replay misses return HTTP 409 with
`{"error":{"type":"tapediff_tool_miss","message":"..."}}`.
Malformed JSON, missing fields, invalid methods or reserved paths, and unknown
or duplicate finish IDs return HTTP 400 with `{"error":{"message":"..."}}`.
Validation messages never echo the request body. Start failures and replay
misses throw without executing the tool. Finish failures warn and preserve
the real result or original error.

Concurrent starts are supported; finish order does not determine tape order.
The record's `id` equals its integer `seq`; the opaque protocol token is never
stored. The `seq` belongs to its start request, placing it between surrounding
LLM requests. Latency spans start to finish. If the process exits before finish,
no tool record is written and shutdown warns once. Do not retry a finish blindly:
its first attempt may already have committed the result.

## Tape, show and diff

[Tape version 2](tape-format.md) adds separate `kind: "tool"` records. Readers
continue accepting version 1 tapes; those have no recorded tools. A wrapped tool
therefore misses when replaying a v1 tape. Re-record it to opt into tool replay.
Arguments, results, and error messages use the same redaction as HTTP bodies;
match keys use the original arguments before redaction.

`show` places a tool directly after the first unmatched preceding `tool_call`
with the same name and canonical-equal arguments, falling back to sequence
position when there is no match. It marks served results `(from tape)` and
prints errors in red. `show --json` adds a top-level `tools` array.
Tool records do not become steps: the existing `tool_result` steps derived from
LLM requests already represent what the model saw. Step diff and the diff JSON
schema are unchanged. A tool whose output never reaches an LLM request does not
create a step difference.

## Limitations

Tools must return JSON data, not handles, iterators, binary objects or class
instances with behavior. JSON does not retain language-specific numeric types
or object identity. Redaction may change replayed values and subsequent requests.
Values round-trip through JSON; floats with integral values come back as ints
in Python. For example, `92.0` replays as `92`, which can change printed output
or strings sent in later requests. Normalize these values before returning them
if their printed representation matters.

Skipping side effects is the purpose of replay. If a later step needs a file
created by a tool, replaying only that tool's return value will not create the
file. Wrap the dependent work together or make subsequent steps depend on JSON
results. Unwrapped tools and computation outside wrappers remain live.

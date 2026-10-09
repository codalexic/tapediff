# Node + Anthropic streaming trip helper

Try a complete tool loop without an API key. The committed tapes contain local
mock model responses; weather and currency tools use deterministic demo data.

## Setup

Requires Node >=20. At the repository root, run `npm ci` and `npm run build`,
then `cd examples/ts-anthropic` and `npm ci` for the pinned official SDK and the
local `tapediff` dependency (`file:../..`). The tools import `tapediff/tools`
through the public package export, just as an installed agent would; the local
dependency keeps this checkout and CI on the same implementation.
The agent is plain `.mjs` with JSDoc: no TypeScript compiler is needed.

Run all commands below from this example directory. Install the CLI with
`npm install -g tapediff`, or replace `tapediff` with
`node ../../dist/cli.js` to use the built checkout.
Installation needs internet; this walkthrough needs no keys or mock server.

## Try it

Replay Paris (exit 0):

```sh
tapediff replay tapes/paris.tape -- node agent.mjs
```

Inspect the inputs, tool calls, results and answer (exit 0):

```sh
tapediff show tapes/paris.tape
```

Compare Paris with Tokyo (expected exit **1**):

```sh
tapediff diff tapes/paris.tape tapes/tokyo.tape --no-color
```

Catch the regression: a changed prompt adds a second weather call and a fourth
model call, while the final answer stays identical (expected exit **1**):

```sh
tapediff diff tapes/paris.tape regressions/paris-v2.tape --no-color
```

Replay the deliberately regressed agent against its own tape (exit 0):

```sh
tapediff replay regressions/paris-v2.tape -- node agent_v2.mjs paris
```

Check both baseline trips (two PASS rows, exit 0):

```sh
tapediff test tapes -- node agent.mjs "{tape}"
```

Test the regressed agent against the baselines (two FAIL rows, expected exit **1**):

```sh
tapediff test tapes -- node agent_v2.mjs "{tape}"
```

The agent selects Paris/Tokyo from the argument's filename or `TAPEDIFF_TAPE`.
Regression tapes live outside `tapes/` so the baseline suite stays green.

## Record your own

Set `ANTHROPIC_API_KEY` in your environment, then run
`tapediff record --out my-trip.tape -- node agent.mjs paris`.
This uses the live provider and incurs charges. To regenerate all six bundled
tapes locally instead, install both examples' dependencies, build, and run
`npm run examples:record` from the repository root. It starts/stops a mock and
runs the real CLI with `--force`; timestamps and timings vary. Do not hand-edit tapes.

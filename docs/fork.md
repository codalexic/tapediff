# Fork a run

```sh
tapediff record --out before.tape -- python my_agent.py
tapediff show before.tape
# edit my_agent.py
tapediff fork before.tape --at 3 --diff -- python my_agent.py
```

Fork lets you iterate on call N without paying for calls 1 through N-1 again.

## Divergence mode

```sh
tapediff fork before.tape --diff -- python my_agent.py
```

Without `--at`, fork serves requests that match the tape using replay's strict
[matching rules](matching.md). The first unmatched LLM request or wrapped tool switches the run
permanently to live traffic. If you change call #2, call #1 comes from the tape
and #2 onward reach the provider, even if a later request would match. Stderr
names the divergent call and shows a redacted request diff. Responses already
being served from tape finish normally.

## Positional mode

```sh
tapediff fork before.tape --at 3 --out after.tape -- python my_agent.py
```

The first two incoming LLM requests receive the first two recorded responses,
even if their prompts changed; call #3 onward goes live. Call numbers match
`show` and exclude unknown-provider requests. `--at 1` makes all LLM calls live.

Each changed request served from tape produces a warning. An endpoint change
or an exhausted tape switches to live early instead. The output stores your
new requests, so `tapediff replay after.tape -- python my_agent.py` can replay
the edited program.

## Caveats

- **Positional serving can hide prefix behavior changes.** An old response may
  no longer suit a changed prompt, model, or tool definition. Review the warnings
  and diff before relying on the result.
- **Unwrapped tools and local computation remain nondeterministic.** Fork
  restarts the command without restoring process or tool state. Wrapped tools
  serve strictly matching recorded JSON results until the run goes live. In
  divergence mode a tool miss switches permanently; in positional mode a tool
  miss runs live without switching. Once the LLM boundary is crossed, all tools
  run live. Skipped side effects may matter to later steps; see [tools](tools.md).
- **Arrival order determines position.** Concurrent requests may arrive in a
  different order than during recording. Divergence mode is safer for concurrent
  runs because distinct matching requests can arrive out of order.
- **Unknown routes do not advance the LLM count or trigger divergence.** They
  use strict matching until divergence; positional mode always matches them
  separately. An unprefixed unknown route that is not served from tape gets the
  same recorded 404 as record: "use /openai/ or /anthropic/ proxy routes".

[LangGraph checkpoints](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint)
store graph state, and its time travel operates within that graph runtime.
Fork is framework-agnostic: it reruns the command and substitutes HTTP responses
without restoring graph state or skipping local computation.

## Reference

- **Output:** `runs/a.tape` defaults to `runs/a.fork.tape`; use `--out` to choose
  another path and `--force` to replace an existing output. `{tape}` and
  `TAPEDIFF_TAPE` point to the absolute source path.
- **Provenance:** writers produce version 2 tapes with optional `forkedFrom` in
  the header and `servedFrom.seq` on served exchanges and tools. Version 1 tapes
  remain readable. Recorded responses, usage, cost, and
  latency are retained. `show` marks served calls; provenance does not affect
  diff equality. See the [tape format](tape-format.md) for fields and redaction.
- **Credentials:** fork inherits real keys and record's upstream configuration;
  it injects no dummy keys. If both provider keys are empty or unset, it warns
  and continues for gateways that need no keys.
- **Timing:** `--pace instant` is the default. `--pace recorded` uses recorded
  SSE offsets, without reproducing initial response latency.
- **Summary:** stderr reports served/live LLM and tool counts and estimated saved cost
  and tokens, or `cost unknown` for unpriced calls. Unused calls warn only if
  the run never went live.
- **Exit codes:** fork returns the child's code, 3 for proxy failure, or 2 for
  usage/read/setup errors. `--diff` prints the normal text report without
  changing that code; `NO_COLOR` and `--no-color` apply. Signals use record's
  shutdown behavior, and flushed tape lines remain readable after interruption.

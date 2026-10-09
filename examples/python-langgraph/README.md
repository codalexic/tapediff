# Python + LangGraph trip planner

Three `StateGraph` nodes share a typed state: `research` runs an LLM tool loop,
`draft` writes a day plan, and `review` checks it against the tool facts.
The draft prompt incorrectly labels a Celsius reading as Fahrenheit.
`agent_v2.py` changes only that prompt to use Celsius.

The tools use deterministic demo data and the vendored `tapediff_tools.py`,
identical to `clients/python/tapediff_tools.py`. They print `executing` inside
their wrapped functions, so you can see when replay skips execution.
There is no LangGraph-specific code in tapediff: it records the HTTP boundary.

## Setup

Requires Node ≥20 and Python ≥3.10. From the repository root, run `npm ci` and
`npm run build`, then `cd examples/python-langgraph` and `python -m venv .venv`.
Activate with `.venv\Scripts\Activate.ps1` (PowerShell),
`.venv\Scripts\activate.bat` (Command Prompt), or `source .venv/bin/activate`
(macOS/Linux). Run `python -m pip install -r requirements.txt`.
Keep this venv separate from `python-openai`, whose older OpenAI SDK pin conflicts.

The requirements pin [LangGraph 1.2.14](https://pypi.org/project/langgraph/1.2.14/)
and [langchain-openai 1.7.0](https://pypi.org/project/langchain-openai/1.7.0/),
the latest stable releases returned by PyPI when checked on 2026-10-09.
Transitive dependencies are resolved by pip, not locked here.

Use the built checkout: replace `tapediff` below with `node ../../dist/cli.js`.
All commands run from this example directory. The transcripts below were captured
against the local mock; usage is synthetic and timings vary.

## Record the bug

In another terminal at the repository root, run `node examples/_mock/mock-llm.mjs`.
It prints its loopback URL. In the example terminal set `OPENAI_BASE_URL` to that
URL plus `/v1`, and `OPENAI_API_KEY` to `tapediff-local-mock`. For example, on
PowerShell use `$env:OPENAI_BASE_URL='http://127.0.0.1:<port>/v1'` and
`$env:OPENAI_API_KEY='tapediff-local-mock'`; on macOS/Linux use `export`.
Clear any `TAPEDIFF_OPENAI_UPSTREAM` override first.
Keep the mock running through the fork step.

The committed baseline is already at `tapes/trip.tape`. To run this exact record
command, first move that file aside; alternatively add `--force` to replace it.

```sh
tapediff record --out tapes/trip.tape -- python agent.py
```

```text
executing get_weather
executing convert_currency
draft: Paris: sunny, 22 F. Budget: 92 EUR. Walk by the Seine.
review: FAIL: the forecast is 22 C, not 22 F. The 92 EUR budget is correct.
recorded 5 exchanges · 625 tokens · $0.0001 → tapes/trip.tape
```

## Find the draft call

```sh
tapediff show tapes/trip.tape
```

```text
» system: "Research the trip. Use get_weather and convert_currency before answering."
» user: "Plan a day in Paris with a budget of 100 USD in EUR."
#1  gpt-4.1-nano  100→25 tok  $0.00002  36ms
    → tool_call get_weather {"city":"Paris"}
    ⚙ get_weather {"city":"Paris"} → {"city":"Paris","condition":"sunny","temperature_c":22} 5ms
    ← tool_result get_weather {"city":"Paris","condition":"sunny","temperature_c":22}
#2  gpt-4.1-nano  100→25 tok  $0.00002  5ms
    → tool_call convert_currency {"amount":100,"source":"USD","target":"EUR"}
    ⚙ convert_currency {"amount":100,"source":"USD","target":"EUR"} → {"amount":92,"currency":"EUR…
    ← tool_result convert_currency {"amount":92,"currency":"EUR"}
#3  gpt-4.1-nano  100→25 tok  $0.00002  4ms
    "Paris: sunny, 22 C. Your 100 USD is 92 EUR. Enjoy a walk by the Seine."
» system: "Draft a day plan. Label the weather number as Fahrenheit. Keep the budget in EUR."
» user: "Plan a day in Paris with a budget of 100 USD in EUR.\nFacts: {\"get_weather\": {\"city\": …
#4  gpt-4.1-nano  100→25 tok  $0.00002  3ms
    "Paris: sunny, 22 F. Budget: 92 EUR. Walk by the Seine."
» system: "Review the day plan against the facts. Flag incorrect units or budgets."
» user: "Facts: {\"get_weather\": {\"city\": \"Paris\", \"condition\": \"sunny\", \"temperature_c\"…
#5  gpt-4.1-nano  100→25 tok  $0.00002  3ms
✓ final: "FAIL: the forecast is 22 C, not 22 F. The 92 EUR budget is correct."
total: 5 calls · 625 tokens · $0.0001 · 50ms
```

Research uses calls #1–#3 and two recorded tools. Draft is #4; review is #5.

## Fix only the draft prompt and fork

`agent_v2.py` calls the same graph with `FIXED_PROMPT`: the word `Fahrenheit`
becomes `Celsius`. The original facts, research prompt, and review prompt stay the same.
The fork serves research and tools from tape, then contacts the mock for draft
and review. Move aside `tapes/trip.fork.tape` if rerunning this command.

```sh
tapediff fork tapes/trip.tape --at 4 --diff -- python agent_v2.py
```

```text
draft: Paris: sunny, 22 C. Budget: 92 EUR. Walk by the Seine.
review: PASS: the plan matches 22 C and the 92 EUR budget.
fork: 3 calls + 2 tools from tape · 2 live calls · 0 live tools · saved $0.00006 (375 tokens) → tapes\trip.fork.tape
tapediff · tapes/trip.tape → tapes\trip.fork.tape
first divergence at step 11

  … 10 identical steps …
~ input system
  …the weather number as [-Fahrenheit-]{+Celsius+}. Keep the budget in EUR.
  input user "Plan a day in Paris with a budget of 100 USD in EUR.\nFacts: {\"get_weather\": {\"cit…
  llm_call gpt-4.1-nano · HTTP 200
~ text
  Paris: sunny, 22 [-F-]{+C+}. Budget: 92 EUR. Walk by the Seine.
  input system "Review the day plan against the facts. Flag incorrect units or budgets."
~ input user
  …Paris: sunny, 22 [-F-]{+C+}. Budget: 92 EUR. Walk by the Seine.
  llm_call gpt-4.1-nano · HTTP 200

tool calls: no change
final answer
  [-FAIL-]{+PASS+}: the [-forecast-]{+plan+} [-is-]{+matches+} 22 C[-,-] [-not-]{+and+} [-22-]{+the…

calls   5 → 5 (no change)
tokens  625 → 625 (no change)
cost    $0.0001 → $0.0001 (no change)
latency 50ms → 59ms (+9ms; +18%)
by model
  gpt-4.1-nano · calls 5 → 5 · tokens 625 → 625 · $0.0001 → $0.0001

✗ behavior differs
```

Both draft text and review change. There are no `executing` lines; the summary
reports two tools served from tape. The saved cost is an estimate from synthetic
mock usage, not a provider bill. Fork with `--diff` exits 0 when the child succeeds,
even though the diff finds changes. Omitting `--at 4` also switches at the changed
draft request in this example.

## Replay the fork offline

Stop the mock with Ctrl+C and unset `OPENAI_API_KEY`. Replay uses no provider:

```sh
tapediff replay tapes/trip.fork.tape -- python agent_v2.py
```

```text
draft: Paris: sunny, 22 C. Budget: 92 EUR. Walk by the Seine.
review: PASS: the plan matches 22 C and the 92 EUR budget.
replayed 5 exchanges · 2 tools · 0 misses · 0 fallbacks ← tapes/trip.fork.tape
```

Two successive replays produced identical stdout. The tests also run with the
mock closed and upstreams pointed at an unreachable loopback port.
To try the committed fixed tape directly, replay `regressions/trip.fork.tape`
with `agent_v2.py`. Check the baseline with
`tapediff test tapes/trip.tape -- python agent.py`; use the fixed agent for the fork.
Keep mixed prompt versions out of a single baseline suite.

## Environment and scope

`ChatOpenAI` is constructed without a `base_url`. The installed client honors
`OPENAI_BASE_URL` through the OpenAI SDK when `OPENAI_API_BASE` is unset.
LangChain's `OPENAI_API_BASE` takes precedence when set; tapediff sets both
variables to its proxy URL. Both the environment-only client configuration and
mock-backed record/fork/replay are tested. No SDK patch or framework callback is used.

The graph starts from its initial state on every run. Fork does not load a
checkpoint or restore process memory; the research node runs again using stored
HTTP responses and JSON tool results. This is not a test of model quality.
For a real provider, stop using the mock URL and supply a real key; record and
the live portion of fork then incur provider charges.

From the repository root, `npm run examples:record` regenerates the baseline and
`regressions/trip.fork.tape` alongside the other examples, skipping Python examples
whose interpreter or dependencies are missing.

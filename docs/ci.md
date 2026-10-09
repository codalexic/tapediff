# CI without provider secrets

Commit reviewed tapes alongside deterministic scenario inputs and your agent.
Install the agent's dependencies and Node ≥20. Replay supplies placeholder keys
when provider API keys are empty; the proxy makes no upstream calls.
Dependency installation still needs a package registry or a cache. Tools that
your agent executes need their own fixtures or mocks.

## GitHub Actions

This workflow runs the bundled example from a checkout of this repo. For your
project, install its dependencies and point `test` at your reviewed tapes:

```yaml
name: Example snapshots
on: [push, pull_request]
permissions:
  contents: read
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - uses: actions/setup-python@v7
        with:
          python-version: '3.11'
      - run: npm ci
      - run: npm run build
      - run: python -m pip install -r examples/python-openai/requirements.txt
      - working-directory: examples/python-openai
        run: node ../../dist/cli.js test tapes -- python agent.py "{tape}"
```

No secrets are configured. The repository's existing [CI workflow](../.github/workflows/ci.yml)
checks build, lint, types, and offline tests on Windows, macOS and Linux with Node
20/22/24. The snippet above specifically sets up the Python example as well.

## Generic CI

From the Python example directory after installing dependencies and building:

```sh
node ../../dist/cli.js test tapes -- python agent.py "{tape}"
```

Keep the command's exit code as the job result. The example selects a scenario
from the tape filename. Other agents need equivalent scenario selection; passing
the tape path is not automatic prompt generation. The suite searches directories
recursively; put deliberately failing/regression tapes outside the baseline folder.

`test` exits 1 for any replay miss, unused call, or child failure. No tapes found
is exit 2. It does not assert final stdout, validate tool side effects, or evaluate
answer quality. Add application assertions for those requirements.

## Updating tapes

1. Keep the baseline and change the agent/prompt intentionally.
2. Re-record to a **new path** using the scenario and a provider key in your
   local environment. Record may incur charges. For the bundled examples,
   `npm run examples:record` instead uses a local mock and overwrites eight
   example tapes when both Python environments are installed; timestamps and timings vary.
3. Review `tapediff diff` between the baseline and candidate. Exit 1 is expected
   for a change. Inspect the first changed prompt, tools, final answer, and totals;
   inspect complete content with JSON or the interactive viewer if truncated.
4. Review the tape contents for sensitive data, replace only the accepted
   baseline, and rerun `test`. Open a PR containing the agent change, tapes, and
   a description of the expected behavior difference. There is no automatic
   approve/update flag or PR comment bot.

The bundled regression makes this review concrete (run from `examples/python-openai`):

```sh
tapediff diff tapes/paris.tape regressions/paris-v2.tape --no-color
```

It exposes a second weather call and a fourth LLM call despite an unchanged final
answer.

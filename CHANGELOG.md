# Changelog

## 0.2.0 - Unreleased

- `fork` reuses recorded calls until a request changes, or until a chosen call with `--at`; `--diff` shows the continuation and a summary reports saved usage
- Opt-in tool recording and replay for JavaScript/TypeScript and Python, including recorded errors and fork prefixes
- Tape format 2 adds tool records and fork provenance; readers still accept v1 tapes, but v0.1 cannot read v2 tapes
- `export` writes OTLP/JSON or sends it to an OTLP/HTTP endpoint, with message content off by default
- A LangGraph example demonstrates fixing a draft prompt while reusing research calls and tools
- Export code loads lazily, keeping it out of `--version` startup

## [0.1.0] - 2026-10-09

First release.

- `record`, `replay`, `test`, `show` and `diff` commands
- OpenAI Chat Completions and Responses API, Anthropic Messages, including streaming
- Strict and loose request matching for replay
- Diff output as text, JSON or an interactive TUI (`--tui`)
- API keys and auth headers are redacted from tapes
- Python and Node examples that run without an API key

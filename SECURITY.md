# Security

If you find a vulnerability, please email
[alex.tsiklauri.career@gmail.com](mailto:alex.tsiklauri.career@gmail.com)
instead of opening a public issue. Include the version, your OS and a minimal
repro. Please don't send real API keys or private tapes.

## Tapes and credentials

Tapes contain your prompts, model responses, tool data and the command you ran.
Look through them before you commit or share them. API keys, auth headers and
common secret formats are stripped automatically (see
[redaction](docs/tape-format.md#redaction)), but that's not the same as
anonymizing your data.

Keep keys in environment variables rather than CLI arguments. If a key does end
up somewhere it shouldn't, rotate it with the provider; deleting it from a tape
doesn't revoke it.

The proxy only listens on `127.0.0.1`. It isn't a sandbox: your agent and its
tools run with your permissions, and replay can't stop them from making their
own network calls.

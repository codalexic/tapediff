# Python tool helper

Copy `tapediff_tools.py` next to your agent and import `tool` or `recorded_tool`.
Requires Python 3.9+ and only the standard library. There is no pip package or
extra dependency; the file is intentionally excluded from the npm tarball.

```python
from tapediff_tools import recorded_tool

@recorded_tool()
def get_weather(city):
    return {"city": city, "temperature": 22}

print(get_weather(city="Paris"))
```

Without `TAPEDIFF_PROXY_URL`, calls run normally. The CLI sets it when recording,
replaying, testing, or forking. Return JSON data. Replay skips execution and
raises `TapediffToolError` for recorded errors or `TapediffToolMiss` on a miss.
See [usage and protocol](../../docs/tools.md), especially the side-effect caveat.

Run tests from the repository root:

```sh
python -m unittest discover -s clients/python -v
```

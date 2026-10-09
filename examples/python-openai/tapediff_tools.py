"""Opt-in JSON tool recording for Python 3.9+, using only the standard library."""

import functools
import json
import os
import sys
import urllib.error
import urllib.request


class TapediffToolError(Exception):
    def __init__(self, name, message):
        super().__init__(message)
        self.name = name
        self.message = message
        self.tapediff_replayed = True


class TapediffToolMiss(Exception):
    pass


def _json(value):
    try:
        return json.dumps(value, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        raise TypeError("tapediff tools must return JSON data and use JSON arguments") from None


def _post(base, route, value):
    request = urllib.request.Request(
        base.rstrip("/") + "/tapediff/v1/tools/" + route,
        data=_json(value), headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response) if response.status != 204 else None
    except urllib.error.HTTPError as error:
        if error.code == 409:
            with error:
                message = json.load(error)["error"]["message"]
            raise TapediffToolMiss(message) from None
        error.close()
        raise RuntimeError(f"tapediff tool {route} failed (HTTP {error.code})") from None


def tool(name, args, fn):
    base = os.environ.get("TAPEDIFF_PROXY_URL")
    if not base:
        return fn(args)
    reply = _post(base, "start", {"name": name, "args": args})
    if reply["action"] == "replay":
        if "error" in reply:
            error = reply["error"]
            raise TapediffToolError(error["name"], error["message"])
        return reply["result"]
    try:
        result = fn(args)
    except Exception as error:
        try:
            _post(base, "finish", {"id": reply["id"], "error": {
                "name": type(error).__name__, "message": str(error),
            }})
        except Exception:
            print("warning: tapediff could not record the tool error; rethrowing the original error", file=sys.stderr)
        raise
    _json(result)
    try:
        _post(base, "finish", {"id": reply["id"], "result": result})
    except Exception:
        print(f"tapediff: could not record result of tool {name}; the tape will be missing it", file=sys.stderr)
    return result


def recorded_tool(name=None):
    """Decorate a function called with keyword arguments."""
    def decorate(fn):
        @functools.wraps(fn)
        def wrapped(**kwargs):
            return tool(name or fn.__name__, kwargs, lambda args: fn(**args))
        return wrapped
    return decorate

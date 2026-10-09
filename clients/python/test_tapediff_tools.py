import json
import io
import os
import urllib.error
import unittest
from unittest.mock import patch

from tapediff_tools import tool, recorded_tool, TapediffToolError, TapediffToolMiss, _json, _post


class ToolsTest(unittest.TestCase):
    def test_direct_identity_and_error(self):
        value = object()
        error = ValueError("original")
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": ""}):
            self.assertIs(tool("x", value, lambda args: args), value)
            def fail(args):
                raise error
            with self.assertRaises(ValueError) as caught:
                tool("x", None, fail)
            self.assertIs(caught.exception, error)

    def test_decorator(self):
        @recorded_tool()
        def add(x, y=1):
            return x + y
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": ""}):
            self.assertEqual(add(x=2), 3)
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", side_effect=[{"action": "run", "id": "1"}, None]
        ) as post:
            self.assertEqual(add(x=2, y=4), 6)
            self.assertEqual(post.call_args_list[0].args[2], {"name": "add", "args": {"x": 2, "y": 4}})

    def test_replay_skips_function(self):
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", return_value={"action": "replay", "result": {"x": 1}}
        ):
            self.assertEqual(tool("x", {}, lambda args: self.fail("ran")), {"x": 1})

    def test_record_error_has_no_stack(self):
        error = ValueError("original")
        def fail(args):
            raise error
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", side_effect=[{"action": "run", "id": "1"}, None]
        ) as post:
            with self.assertRaises(ValueError) as caught:
                tool("x", {}, fail)
            self.assertIs(caught.exception, error)
            self.assertEqual(post.call_args.args[2], {"id": "1", "error": {"name": "ValueError", "message": "original"}})

    def test_replayed_error(self):
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", return_value={"action": "replay", "error": {"name": "ValueError", "message": "bad"}}
        ):
            with self.assertRaises(TapediffToolError) as caught:
                tool("x", {}, lambda args: self.fail("ran"))
            self.assertEqual(caught.exception.name, "ValueError")
            self.assertEqual(str(caught.exception), "bad")
            self.assertEqual(caught.exception.message, "bad")
            self.assertTrue(caught.exception.tapediff_replayed)

    def test_invalid_json(self):
        cycle = []
        cycle.append(cycle)
        for value in [lambda: None, object(), cycle, float("nan"), float("inf")]:
            with self.subTest(value=type(value)), self.assertRaisesRegex(TypeError, "JSON data"):
                _json(value)
        self.assertIsNone(json.loads(_json(None)))

    def test_miss_skips_function(self):
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", side_effect=TapediffToolMiss("missing")
        ):
            with self.assertRaises(TapediffToolMiss):
                tool("x", {}, lambda args: self.fail("ran"))

    def test_http_errors(self):
        for status, exception in [(400, RuntimeError), (409, TapediffToolMiss)]:
            body = io.BytesIO(b'{"error":{"message":"missing"}}')
            error = urllib.error.HTTPError("http://localhost", status, "error", {}, body)
            with patch("urllib.request.urlopen", side_effect=error), self.assertRaises(exception):
                _post("http://localhost", "start", {"name": "x", "args": {}})
            self.assertTrue(body.closed)

    def test_timeout(self):
        response = io.BytesIO(b'{"action":"run","id":"token"}')
        response.status = 200
        with patch("urllib.request.urlopen", return_value=response) as urlopen:
            self.assertEqual(_post("http://localhost", "start", {"name": "x", "args": {}})["id"], "token")
            self.assertEqual(urlopen.call_args.kwargs, {"timeout": 30})

    def test_original_error_wins_when_finish_fails(self):
        original = ValueError("original")
        def fail(args):
            raise original
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", side_effect=[{"action": "run", "id": "token"}, OSError("private transport details")]
        ), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            with self.assertRaises(ValueError) as caught:
                tool("x", {}, fail)
            self.assertIs(caught.exception, original)
            self.assertEqual(stderr.getvalue(), "warning: tapediff could not record the tool error; rethrowing the original error\n")

    def test_successful_tool_exposes_finish_failure(self):
        transport = OSError("transport")
        with patch.dict(os.environ, {"TAPEDIFF_PROXY_URL": "http://localhost"}), patch(
            "tapediff_tools._post", side_effect=[{"action": "run", "id": "token"}, transport]
        ), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            with self.assertRaises(OSError) as caught:
                tool("x", {}, lambda args: 42)
            self.assertIs(caught.exception, transport)
            self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

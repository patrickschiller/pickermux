"""Offline tests: never import MLX, download weights or touch live configuration."""

import hashlib
import http.client
import contextlib
import io
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("kolibri_launcher", Path(__file__).parents[1] / "scripts" / "serve-kolibri.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def request_body(**overrides):
  return {"model": launcher.MODEL_ALIAS, "messages": [{"role": "user", "content": "Hallo"}], **overrides}


class LauncherTests(unittest.TestCase):
  def test_exact_snapshot_files_and_no_modified_or_foreign_data(self):
    with tempfile.TemporaryDirectory() as directory:
      model_dir = Path(directory)
      model_file = model_dir / "model.safetensors"
      model_file.write_bytes(b"offline fixture")
      model_file.chmod(0o600)
      manifest = {model_file.name: hashlib.sha256(model_file.read_bytes()).hexdigest()}
      launcher.verify_snapshot(model_dir, manifest)
      model_dir.chmod(0o755)
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest)
      model_dir.chmod(0o700)
      model_file.chmod(0o644)
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest)
      model_file.chmod(0o600)
      model_file.write_bytes(b"modified")
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest)
      model_file.unlink()
      model_file.write_bytes(b"offline fixture")
      model_file.chmod(0o600)
      with tempfile.TemporaryDirectory() as linked_directory:
        hardlink = Path(linked_directory) / "hardlink"
        hardlink.hardlink_to(model_file)
        with self.assertRaises(launcher.ContractError):
          launcher.verify_snapshot(model_dir, manifest)
      model_file.unlink()
      launcher.verify_snapshot(model_dir, manifest, allow_missing=True)
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest)
      foreign = model_dir / "other.py"
      foreign.write_text("raise Exception('do not execute')")
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest, allow_missing=True)
      foreign.unlink()
      model_file.symlink_to(model_dir / "missing")
      with self.assertRaises(launcher.ContractError):
        launcher.verify_snapshot(model_dir, manifest, allow_missing=True)

  def test_pins_and_venv_are_mandatory(self):
    with patch.object(launcher.sys, "prefix", "isolated"), patch.object(launcher.sys, "base_prefix", "base"), patch.object(launcher.platform, "system", return_value="Darwin"), patch.object(launcher.platform, "machine", return_value="arm64"):
      launcher.check_runtime(version=launcher.RUNTIME_VERSIONS.__getitem__)
      with self.assertRaises(launcher.ContractError):
        launcher.check_runtime(version=lambda name: "different")
      with patch.object(launcher.sys, "prefix", "base"):
        with self.assertRaises(launcher.ContractError):
          launcher.check_runtime(version=launcher.RUNTIME_VERSIONS.__getitem__)

  def test_only_bounded_text_no_tools_alias_paths_or_reasoning(self):
    valid = launcher.validate_request(request_body(stream=True, max_tokens=16), 32)
    self.assertEqual(valid["max_tokens"], 16)
    for body in [
      request_body(model="default_model"),
      request_body(model="/private/model"),
      request_body(tools=[]),
      request_body(tool_choice="none"),
      request_body(adapters="private"),
      request_body(max_tokens=True),
      request_body(max_tokens=33),
      request_body(max_tokens=1, max_completion_tokens=1),
      request_body(temperature=float("inf")),
      request_body(stream="true"),
      request_body(chat_template_kwargs={"reasoning_effort": "high"}),
      request_body(messages=[{"role": "tool", "content": "result"}]),
      request_body(messages=[{"role": "user", "content": [{"type": "image"}]}]),
      request_body(messages=[{"role": "user", "content": "hello", "name": "private"}]),
      request_body(messages=[{"role": "user", "content": "hello"}, {"role": "system", "content": "late"}]),
    ]:
      with self.subTest(body=body):
        with self.assertRaises(launcher.ContractError):
          launcher.validate_request(body, 32)

  def test_context_checked_after_template_before_generation(self):
    calls = []
    tokenizer = SimpleNamespace(apply_chat_template=lambda *args, **kwargs: calls.append(kwargs) or [1] * 10)
    part = SimpleNamespace(text="Hallo!", finish_reason="stop", prompt_tokens=10, generation_tokens=3)
    runtime = launcher.KolibriRuntime(None, tokenizer, lambda *args, **kwargs: iter([part]), lambda *args, **kwargs: None, 16)
    result = runtime.complete(launcher.validate_request(request_body(max_tokens=6), 32))
    self.assertEqual(result, ("Hallo!", "stop", {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}))
    self.assertEqual(calls[0]["reasoning_effort"], "none")
    self.assertFalse(calls[0]["enable_thinking"])
    with self.assertRaisesRegex(launcher.ContractError, "configured context"):
      runtime.complete(launcher.validate_request(request_body(max_tokens=7), 32))
    for text in ["<tool_call>{broken}", "<think>private", "</think>"]:
      part.text = text
      with self.assertRaises(launcher.ContractError):
        runtime.complete(launcher.validate_request(request_body(max_tokens=6), 32))
    part.text = "valid"
    part.generation_tokens = 7
    with self.assertRaises(launcher.ContractError):
      runtime.complete(launcher.validate_request(request_body(max_tokens=6), 32))
    runtime.lock.acquire()
    try:
      with self.assertRaisesRegex(launcher.ContractError, "another request"):
        runtime.complete(launcher.validate_request(request_body(max_tokens=6), 32))
    finally:
      runtime.lock.release()

  def test_loopback_json_and_sse_and_private_failure(self):
    class FakeRuntime:
      context_window = 8192
      def complete(self, request):
        if request["messages"][0]["content"] == "fail":
          raise ValueError("PRIVATE_PROMPT /private/model SECRET")
        return "Hallo!", "stop", {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    with patch("socket.getfqdn", side_effect=AssertionError("Do not resolve DNS")):
      server = launcher.KolibriServer(("127.0.0.1", 0), launcher.KolibriHandler)
    server.runtime = FakeRuntime()
    server.max_tokens = 32
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
      def send(method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read().decode()
        connection.close()
        return result
      status, _, body = send("GET", "/v1/models")
      self.assertEqual(status, 200)
      self.assertEqual(json.loads(body)["data"], [{"id": launcher.MODEL_ALIAS, "object": "model", "context_window": 8192}])
      self.assertEqual(send("GET", "/v1/models/private/path")[0], 404)
      self.assertEqual(send("GET", "/v1/models", headers={"Origin": "https://example.invalid"})[0], 403)
      self.assertEqual(send("GET", "/v1/models", headers={"Host": "other.invalid"})[0], 403)
      headers = {"Content-Type": "application/json"}
      status, _, body = send("POST", "/v1/chat/completions", json.dumps(request_body()), headers)
      self.assertEqual(status, 200)
      self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], "Hallo!")
      status, response_headers, body = send("POST", "/v1/chat/completions", json.dumps(request_body(stream=True, stream_options={"include_usage": True})), headers)
      self.assertEqual(status, 200)
      self.assertEqual(response_headers["Content-Type"], "text/event-stream")
      packets = [json.loads(item.removeprefix("data: ")) for item in body.strip().split("\n\n")[:-1]]
      self.assertEqual(packets[-1]["object"], "chat.completion")
      self.assertEqual(packets[-1]["usage"]["total_tokens"], 5)
      self.assertTrue(body.endswith("data: [DONE]\n\n"))
      for malformed in ['{"model":"first","model":"second"}', '{"value":NaN}', '{"bad":', b"\xff"]:
        self.assertEqual(send("POST", "/v1/chat/completions", malformed, headers)[0], 400)
      status, _, body = send("POST", "/v1/chat/completions", json.dumps(request_body(messages=[{"role": "user", "content": "fail"}])), headers)
      self.assertEqual(status, 503)
      for private in ("PRIVATE_PROMPT", "/private/model", "SECRET"):
        self.assertNotIn(private, body)
    finally:
      server.shutdown()
      server.server_close()
      thread.join(timeout=3)

  def test_socket_error_never_prints_private_traceback(self):
    class FailingHandler(launcher.KolibriHandler):
      def reply(self, status, body):
        raise BrokenPipeError("PRIVATE_SOCKET /private/model SECRET")
    captured = io.StringIO()
    server = launcher.KolibriServer(("127.0.0.1", 0), FailingHandler)
    server.runtime = SimpleNamespace(context_window=8192)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    with contextlib.redirect_stderr(captured):
      thread.start()
      try:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        connection.request("GET", "/v1/models")
        with self.assertRaises(http.client.RemoteDisconnected):
          connection.getresponse()
        connection.close()
        server.handle_error(None, None)
      finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    self.assertEqual(captured.getvalue(), "")


if __name__ == "__main__":
  unittest.main()

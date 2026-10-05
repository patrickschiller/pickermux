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


spec = importlib.util.spec_from_file_location("kolibri_launcher", Path(__file__).parents[1] / "runtime" / "mlx" / "kolibri.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def request_body(**overrides):
  return {"model": launcher.MODEL_ALIAS, "messages": [{"role": "user", "content": "Hallo"}], **overrides}


def function_tool():
  return {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}


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
      request_body(tools={}),
      request_body(tool_choice="unknown"),
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
    self.assertEqual(result, ("Hallo!", "stop", {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}, [], None))
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

  def test_strict_function_parser_and_choices(self):
    request = launcher.validate_request(request_body(tools=[function_tool()]), 32)
    text, finish, calls = launcher.parse_completion('<tool_call>\n{"name":"lookup","arguments":{"query":"Example"}}\n</tool_call>', "stop", request)
    self.assertEqual(text, "")
    self.assertEqual(finish, "tool_calls")
    self.assertEqual(len(calls), 1)
    self.assertEqual(calls[0]["function"], {"name": "lookup", "arguments": '{"query":"Example"}'})
    self.assertTrue(calls[0]["id"].startswith("call_"))
    for output in [
      '<tool_call>{"name":"unknown","arguments":{}}</tool_call>',
      '<tool_call>{"name":"lookup","arguments":[]}</tool_call>',
      '<tool_call>{"name":"lookup","arguments":{},"extra":true}</tool_call>',
      '<tool_call>{"name":"lookup","name":"other","arguments":{}}</tool_call>',
      '<tool_call>{"name":"lookup","arguments":{"query":"a","query":"b"}}</tool_call>',
      '<tool_call>{"name":"lookup","arguments":{}}',
      '<tool_call>{"name":"lookup","arguments":{}}</tool_call> extra',
      '<tool_call>{"name":"lookup","arguments":{}}</tool_call><tool_call>{}</tool_call>',
      '<think>private</think><tool_call>{"name":"lookup","arguments":{}}</tool_call>',
    ]:
      with self.subTest(output=output):
        with self.assertRaises(launcher.ContractError):
          launcher.parse_completion(output, "stop", request)
    with self.assertRaises(launcher.ContractError):
      launcher.parse_completion('<tool_call>{"name":"lookup","arguments":{}}</tool_call>', "length", request)
    with self.assertRaises(launcher.ContractError):
      launcher.parse_completion('<tool_call>{"name":"lookup","arguments":{}}</tool_call>', "stop", {**request, "tool_choice": "none"})
    with self.assertRaises(launcher.ContractError):
      launcher.parse_completion("No function", "stop", {**request, "tool_choice": "required"})

  def test_complete_function_stops_generation_without_consuming_or_repairing_later_output(self):
    observed = []
    def generate(*args, **kwargs):
      try:
        observed.append("first")
        yield SimpleNamespace(text='<tool_call>{"name":"lookup","arguments":{"query":"Example"}}', finish_reason=None, prompt_tokens=10, generation_tokens=3, generation_tps=2)
        observed.append("closing")
        yield SimpleNamespace(text="</tool_call>", finish_reason=None, prompt_tokens=10, generation_tokens=4, generation_tps=2)
        observed.append("later")
        yield SimpleNamespace(text='<tool_call>{"name":"lookup","arguments":{}}</tool_call>', finish_reason="stop", prompt_tokens=10, generation_tokens=5, generation_tps=2)
      finally:
        observed.append("closed")
    tokenizer = SimpleNamespace(apply_chat_template=lambda *args, **kwargs: [1] * 10)
    runtime = launcher.KolibriRuntime(None, tokenizer, generate, lambda *args, **kwargs: None, 64)
    result = runtime.complete(launcher.validate_request(request_body(tools=[function_tool()], max_tokens=16), 32))
    self.assertEqual(observed, ["first", "closing", "closed"])
    self.assertEqual(result[1], "tool_calls")
    self.assertEqual(result[2], {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14})
    self.assertEqual(result[3][0]["function"], {"name": "lookup", "arguments": '{"query":"Example"}'})
    self.assertEqual(result[4], {"generation_duration_ms": 2000})
    self.assertFalse(runtime.lock.locked())

  def test_function_stop_preserves_and_rejects_coalesced_multiple_calls_suffixes_and_bad_envelopes(self):
    call = '<tool_call>{"name":"lookup","arguments":{}}</tool_call>'
    tokenizer = SimpleNamespace(apply_chat_template=lambda *args, **kwargs: [1] * 10)
    for text in (call + call, call + " extra", '<tool_call>{"name":"lookup","arguments":[]}</tool_call>', '<tool_call>{"name":"unknown","arguments":{}}</tool_call>'):
      observed = []
      def generate(*args, **kwargs):
        try:
          yield SimpleNamespace(text=text, finish_reason=None, prompt_tokens=10, generation_tokens=4, generation_tps=2)
          observed.append("later")
        finally:
          observed.append("closed")
      runtime = launcher.KolibriRuntime(None, tokenizer, generate, lambda *args, **kwargs: None, 64)
      with self.assertRaises(launcher.ContractError):
        runtime.complete(launcher.validate_request(request_body(tools=[function_tool()], max_tokens=16), 32))
      self.assertEqual(observed, ["closed"])
      self.assertFalse(runtime.lock.locked())

  def test_function_stop_rejects_partial_malformed_disabled_and_invalid_count_output(self):
    tokenizer = SimpleNamespace(apply_chat_template=lambda *args, **kwargs: [1] * 10)
    call = '<tool_call>{"name":"lookup","arguments":{}}</tool_call>'
    for text, choice in ((call[:-1], "auto"), ('<tool_call>{broken}</tool_call>', "auto"), (call, "none")):
      part = SimpleNamespace(text=text, finish_reason="stop", prompt_tokens=10, generation_tokens=4, generation_tps=2)
      runtime = launcher.KolibriRuntime(None, tokenizer, lambda *args, **kwargs: iter([part]), lambda *args, **kwargs: None, 64)
      with self.assertRaises(launcher.ContractError):
        runtime.complete(launcher.validate_request(request_body(tools=[function_tool()], tool_choice=choice, max_tokens=16), 32))
    for tokens, prompt in ((0, 10), (True, 10), (17, 10), (4, 9), (4, True)):
      part = SimpleNamespace(text=call, finish_reason=None, prompt_tokens=prompt, generation_tokens=tokens, generation_tps=2)
      runtime = launcher.KolibriRuntime(None, tokenizer, lambda *args, **kwargs: iter([part]), lambda *args, **kwargs: None, 64)
      with self.assertRaises(launcher.ContractError):
        runtime.complete(launcher.validate_request(request_body(tools=[function_tool()], max_tokens=16), 32))

  def test_literal_closing_tag_in_fragmented_arguments_is_not_a_stop_boundary(self):
    observed = []
    def generate(*args, **kwargs):
      try:
        yield SimpleNamespace(text='<tool_call>{"name":"lookup","arguments":{"query":"literal </tool_call>', finish_reason=None, prompt_tokens=10, generation_tokens=3, generation_tps=2)
        observed.append("continued")
        yield SimpleNamespace(text=' text"}}</tool_call>', finish_reason=None, prompt_tokens=10, generation_tokens=4, generation_tps=2)
        observed.append("later")
      finally:
        observed.append("closed")
    tokenizer = SimpleNamespace(apply_chat_template=lambda *args, **kwargs: [1] * 10)
    runtime = launcher.KolibriRuntime(None, tokenizer, generate, lambda *args, **kwargs: None, 64)
    result = runtime.complete(launcher.validate_request(request_body(tools=[function_tool()], max_tokens=16), 32))
    self.assertEqual(observed, ["continued", "closed"])
    self.assertEqual(json.loads(result[3][0]["function"]["arguments"]), {"query": "literal </tool_call> text"})

  def test_function_history_requires_unique_correlated_results(self):
    call = {"id": "call_prior", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
    assistant = {"role": "assistant", "content": "", "tool_calls": [call]}
    output = {"role": "tool", "content": "Source found", "tool_call_id": "call_prior"}
    body = request_body(tools=[function_tool()], messages=[{"role": "user", "content": "Find source"}, assistant, output], tool_choice="none")
    self.assertEqual(launcher.validate_request(body, 32)["messages"], body["messages"])
    for messages in [
      [assistant], [output], [assistant, output, output], [assistant, output, assistant, output],
      [assistant, {**output, "tool_call_id": "other"}],
      [{**assistant, "tool_calls": [{**call, "function": {"name": "other", "arguments": "{}"}}]}, output],
    ]:
      with self.assertRaises(launcher.ContractError):
        launcher.validate_request({**body, "messages": messages}, 32)
    with self.assertRaises(launcher.ContractError):
      launcher.validate_request(body, 32, allow_tools=False)
    with self.assertRaises(launcher.ContractError):
      launcher.validate_request(request_body(tools=[function_tool()], parallel_tool_calls=True), 32)

  def test_pinned_capabilities_and_generation_metrics_are_bounded(self):
    caps = launcher.model_capabilities()
    self.assertEqual(set(caps), {"mlxToolProtocol", "modelFingerprint", "runtimeFingerprint"})
    self.assertEqual(caps["mlxToolProtocol"], "pickermux-mlx-tools-v1")
    for fingerprint in (caps["modelFingerprint"], caps["runtimeFingerprint"]):
      self.assertRegex(fingerprint, r"^sha256:[a-f0-9]{64}$")
    self.assertEqual(launcher.generation_metrics(SimpleNamespace(generation_tokens=4, generation_tps=2)), {"generation_duration_ms": 2000})
    for speed in (None, 0, -1, float("nan"), float("inf"), 0.000001, 5e-324):
      self.assertIsNone(launcher.generation_metrics(SimpleNamespace(generation_tokens=4, generation_tps=speed)))
    self.assertIsNone(launcher.generation_metrics(SimpleNamespace(generation_tokens=4)))
    for name in ('lookup"', "lookup<tool_call>", "lookup\n", "lookup "):
      with self.assertRaises(launcher.ContractError):
        launcher.validate_request(request_body(tools=[{"type": "function", "function": {"name": name, "parameters": {}}}]), 32)

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
      self.assertEqual(json.loads(body)["data"], [{"id": launcher.MODEL_ALIAS, "object": "model", "context_window": 8192, "capabilities": {"mlxMaxOutputTokens": 32}}])
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
    server.max_tokens = 32
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

  def test_http_function_contract_and_decode_duration(self):
    class ToolRuntime:
      context_window = 8192
      model_alias = launcher.MODEL_ALIAS
      tool_capable = True
      capabilities = launcher.model_capabilities()
      def complete(self, request):
        self.asserted_choice = request["tool_choice"]
        call = {"id": "call_result", "type": "function", "function": {"name": "lookup", "arguments": '{"query":"Example"}'}}
        return "", "tool_calls", {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}, [call], {"generation_duration_ms": 125}
    server = launcher.KolibriServer(("127.0.0.1", 0), launcher.KolibriHandler)
    server.runtime = ToolRuntime()
    server.max_tokens = 32
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
      for stream in (False, True):
        body = request_body(tools=[function_tool()], tool_choice="required", parallel_tool_calls=False, stream=stream)
        if stream:
          body["stream_options"] = {"include_usage": True}
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        connection.request("POST", "/v1/chat/completions", json.dumps(body), {"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        output = response.read().decode()
        connection.close()
        if stream:
          packets = [json.loads(item.removeprefix("data: ")) for item in output.strip().split("\n\n")[:-1]]
          self.assertEqual(packets[0]["choices"][0]["delta"], {"role": "assistant"})
          self.assertEqual(packets[-2]["choices"][0]["finish_reason"], "tool_calls")
          self.assertEqual(packets[-2]["choices"][0]["delta"]["tool_calls"][0]["index"], 0)
          self.assertEqual(packets[-1]["choices"], [])
          self.assertEqual(packets[-1]["pickermux_metrics"], {"generation_duration_ms": 125})
          self.assertTrue(output.endswith("data: [DONE]\n\n"))
        else:
          packet = json.loads(output)
          self.assertEqual(packet["choices"][0]["finish_reason"], "tool_calls")
          self.assertEqual(packet["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "lookup")
          self.assertEqual(packet["pickermux_metrics"], {"generation_duration_ms": 125})
        self.assertEqual(server.runtime.asserted_choice, "required")
    finally:
      server.shutdown()
      server.server_close()
      thread.join(timeout=3)


if __name__ == "__main__":
  unittest.main()

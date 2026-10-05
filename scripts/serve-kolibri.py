#!/usr/bin/env python3
"""Serve one verified Kolibri MLX snapshot with a bounded text-only contract."""

import argparse
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import math
import os
import platform
import socketserver
import stat
import sys
import threading
import time
import uuid
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MODEL_REPOSITORY = "velaia/Kolibri-1-MLX-4bit"
MODEL_REVISION = "3f5adf3fc8149f57738cc5a99f02ae26b601e7b0"
MODEL_ALIAS = "kolibri-1-mlx-4bit"
RUNTIME_VERSIONS = {"mlx": "0.32.3", "mlx-lm": "0.32.0", "transformers": "5.7.0", "huggingface-hub": "1.5.0"}
DEFAULT_CONTEXT_WINDOW = 8192
MAX_CONTEXT_WINDOW = 8192
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
CONTROL_MARKERS = ("<think>", "</think>", "<tool_call>", "</tool_call>", "<|im_start|>", "<|im_end|>")

# These digests bind executable architecture code, prompt rendering, tokenizer,
# configuration and all nine weight shards to one immutable public snapshot.
MODEL_SHA256 = {
  "kolibri1.py": "47bc453c65e5d96cd4249046b6590eaff4ccf218598a08d6cb6b7db8a551a471",
  "config.json": "a75147ebeeda41a8bef556d76b4c9e5212a8e639d2cef4cd051e072a3e0495ab",
  "tokenizer_config.json": "506ef37c5c0decf8e3fa213f2ccce43e38177d1b5f40e878d47b861e72e5757a",
  "tokenizer.json": "1b4eaa84ac1d79bf72e4aa2571536468b1c98c6acbdd9efc475cca55933977ec",
  "chat_template.jinja": "9ba35d4bd6baa26b66aa75d03a922dfee98b16bb1fa37481b195d247267b0f97",
  "generation_config.json": "40e0edd01855fc8abdfd2f7b0d4a54c52cf6dea3c678dc68b32c05f19c464450",
  "model.safetensors.index.json": "98424e881a02baa8828e0159ae900f69bb602743a5a67e17978a18b7d08a2ab6",
  "LICENSE": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "model-00001-of-00009.safetensors": "f35f4ec515f79816002ce17029352a7a2211d6239655e771c6a475deb223d816",
  "model-00002-of-00009.safetensors": "64e518ed4e4b7f30de2c96f28bcf5966456aa999cbd1340900b032e6963aa4ee",
  "model-00003-of-00009.safetensors": "250ad2ff022bdcdcb86e97594f19cbc3689c232c4aa31a662d1958b7cf588fa7",
  "model-00004-of-00009.safetensors": "6f2b5bda47fe9088ca4999b27bc872edc088635c092eb4aa78023b116fadc0e2",
  "model-00005-of-00009.safetensors": "6699b3a7c90cff6e786fad1d26475a9a0ce5f336cc4c6e4e7215a51931fc5bba",
  "model-00006-of-00009.safetensors": "4375b5ac17adf4b6ed8ad7fa210a92f793f974261cdcdb609e95bf9992ab7cf9",
  "model-00007-of-00009.safetensors": "68d8cb5814c997020c7bd7321e98e0aa6eeba41921df786c1b8d98ba45aaca3e",
  "model-00008-of-00009.safetensors": "676c15f9331c81a600d4f15aa2e8742dad43ab44bfa879d0be602e1eede310b5",
  "model-00009-of-00009.safetensors": "b9e961409262d03603a2a56df6d1d75638bf1cc34dbb15d7dcb0c8a767f6e8be",
}


class ContractError(Exception):
  def __init__(self, code, message, status=400):
    super().__init__(message)
    self.code = code
    self.status = status


def digest_file(path):
  digest = hashlib.sha256()
  with path.open("rb") as source:
    for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
      digest.update(chunk)
  return digest.hexdigest()


def verify_snapshot(model_dir, manifest=MODEL_SHA256, allow_missing=False):
  if model_dir.is_symlink() or not model_dir.is_dir():
    raise ContractError("MODEL_SNAPSHOT_INVALID", "Use a regular directory for the pinned model snapshot.")
  directory_info = model_dir.stat()
  if directory_info.st_uid != os.getuid() or stat.S_IMODE(directory_info.st_mode) & 0o077:
    raise ContractError("MODEL_SNAPSHOT_INVALID", "The model snapshot directory must be private and owned by the current user.")
  allowed = set(manifest) | {".cache"}
  if any(entry.name not in allowed for entry in model_dir.iterdir()):
    raise ContractError("MODEL_SNAPSHOT_INVALID", "The model snapshot contains unexpected files.")
  for name, expected_digest in manifest.items():
    path = model_dir / name
    if allow_missing and not path.exists() and not path.is_symlink():
      continue
    if path.is_symlink() or not path.is_file() or digest_file(path) != expected_digest:
      raise ContractError("MODEL_SNAPSHOT_INVALID", "The pinned model snapshot is missing or modified.")
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077:
      raise ContractError("MODEL_SNAPSHOT_INVALID", "Model snapshot files must be private, singly linked and owned by the current user.")
  cache_dir = model_dir / ".cache"
  if cache_dir.is_symlink() or (cache_dir.exists() and not cache_dir.is_dir()):
    raise ContractError("MODEL_SNAPSHOT_INVALID", "The model download cache is unsafe.")
  if cache_dir.exists() and any(entry.is_symlink() for entry in cache_dir.rglob("*")):
    raise ContractError("MODEL_SNAPSHOT_INVALID", "The model download cache is unsafe.")


def check_runtime(version=importlib.metadata.version):
  if sys.prefix == sys.base_prefix:
    raise ContractError("RUNTIME_INVALID", "Start Kolibri with the Python interpreter from its isolated virtual environment.")
  if platform.system() != "Darwin" or platform.machine() != "arm64":
    raise ContractError("RUNTIME_INVALID", "The pinned MLX runtime requires an Apple silicon Mac.")
  for package, expected in RUNTIME_VERSIONS.items():
    try:
      actual = version(package)
    except importlib.metadata.PackageNotFoundError:
      actual = None
    if actual != expected:
      raise ContractError("RUNTIME_INVALID", "Install the exact dependency versions documented for Kolibri.")


def download_snapshot(model_dir):
  from huggingface_hub import snapshot_download

  if not model_dir.exists():
    model_dir.mkdir(mode=0o700, parents=True)
  # A retry can fill missing files, but cannot replace modified or foreign data.
  verify_snapshot(model_dir, allow_missing=True)
  snapshot_download(
    repo_id=MODEL_REPOSITORY,
    revision=MODEL_REVISION,
    local_dir=str(model_dir),
    allow_patterns=list(MODEL_SHA256),
    token=False,
  )


def integer(value, minimum, maximum, label):
  if type(value) is not int or not minimum <= value <= maximum:
    raise ContractError("REQUEST_INVALID", label + " is outside the supported bounds.")
  return value


def number(value, minimum, maximum, label):
  if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
    raise ContractError("REQUEST_INVALID", label + " is outside the supported bounds.")
  return value


def json_object(pairs):
  result = {}
  for key, value in pairs:
    if key in result:
      raise ValueError("Duplicate JSON field")
    result[key] = value
  return result


def reject_json_constant(value):
  raise ValueError("Non-finite JSON number")


def validate_request(body, max_tokens):
  allowed = {"model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "stream_options", "chat_template_kwargs"}
  if not isinstance(body, dict) or set(body) - allowed:
    raise ContractError("REQUEST_INVALID", "The request contains unsupported fields.")
  if body.get("model") != MODEL_ALIAS:
    raise ContractError("MODEL_UNKNOWN", "Only the exact configured Kolibri model alias is supported.")
  messages = body.get("messages")
  if not isinstance(messages, list) or not messages or len(messages) > 2048:
    raise ContractError("REQUEST_INVALID", "Supply a bounded list of text messages.")
  for index, message in enumerate(messages):
    if not isinstance(message, dict) or set(message) != {"role", "content"}:
      raise ContractError("REQUEST_INVALID", "Only role and string content are supported in messages.")
    if message["role"] not in ("system", "user", "assistant") or not isinstance(message["content"], str):
      raise ContractError("REQUEST_INVALID", "Only system, user and assistant text messages are supported.")
    if message["role"] == "system" and index != 0:
      raise ContractError("REQUEST_INVALID", "The system message must be first.")
  if "max_tokens" in body and "max_completion_tokens" in body:
    raise ContractError("REQUEST_INVALID", "Supply only one output token limit.")
  output_tokens = integer(body.get("max_completion_tokens", body.get("max_tokens", max_tokens)), 1, max_tokens, "The output token limit")
  stream = body.get("stream", False)
  if type(stream) is not bool:
    raise ContractError("REQUEST_INVALID", "stream must be a boolean.")
  template_args = body.get("chat_template_kwargs", {"reasoning_effort": "none"})
  if template_args != {"reasoning_effort": "none"}:
    raise ContractError("REQUEST_INVALID", "Only reasoning_effort none is supported.")
  stream_options = body.get("stream_options")
  if stream_options is not None and stream_options != {"include_usage": True}:
    raise ContractError("REQUEST_INVALID", "Only include_usage true is supported in stream_options.")
  return {
    "messages": messages,
    "max_tokens": output_tokens,
    "stream": stream,
    "include_usage": stream_options is not None,
    "temperature": number(body.get("temperature", 1.0), 0, 2, "temperature"),
    "top_p": number(body.get("top_p", 0.97), 0, 1, "top_p"),
    "top_k": integer(body.get("top_k", 128), 0, 1024, "top_k"),
  }


class KolibriRuntime:
  def __init__(self, model, tokenizer, stream_generate, make_sampler, context_window):
    self.model = model
    self.tokenizer = tokenizer
    self.stream_generate = stream_generate
    self.make_sampler = make_sampler
    self.context_window = context_window
    self.lock = threading.Lock()

  def complete(self, request):
    # MLX's tokenizer detokenizer and model are shared and must not be mutated
    # concurrently. No cross-request prompt or conversation cache is retained.
    if not self.lock.acquire(blocking=False):
      raise ContractError("MODEL_BUSY", "Kolibri is handling another request.", 503)
    try:
      prompt = self.tokenizer.apply_chat_template(
        request["messages"],
        add_generation_prompt=True,
        tokenize=True,
        reasoning_effort="none",
        enable_thinking=False,
      )
      if len(prompt) + request["max_tokens"] > self.context_window:
        raise ContractError("CONTEXT_LIMIT_EXCEEDED", "The prompt and reserved output exceed the configured context window.")
      sampler = self.make_sampler(request["temperature"], top_p=request["top_p"], top_k=request["top_k"])
      parts = []
      text_bytes = 0
      final = None
      for part in self.stream_generate(self.model, self.tokenizer, prompt, max_tokens=request["max_tokens"], sampler=sampler):
        text_bytes += len(part.text.encode("utf-8"))
        if text_bytes > MAX_RESPONSE_BYTES:
          raise ContractError("MODEL_OUTPUT_INVALID", "Kolibri output exceeded the response limit.", 502)
        parts.append(part.text)
        final = part
      text = "".join(parts)
      if final is None or final.finish_reason not in ("stop", "length") or any(marker in text for marker in CONTROL_MARKERS):
        raise ContractError("MODEL_OUTPUT_INVALID", "Kolibri returned unsupported or incomplete output.", 502)
      if final.prompt_tokens != len(prompt) or type(final.generation_tokens) is not int or not 0 < final.generation_tokens <= request["max_tokens"]:
        raise ContractError("MODEL_OUTPUT_INVALID", "Kolibri returned invalid token counts.", 502)
      return text, final.finish_reason, {
        "prompt_tokens": len(prompt),
        "completion_tokens": final.generation_tokens,
        "total_tokens": len(prompt) + final.generation_tokens,
      }
    finally:
      self.lock.release()


def load_runtime(model_dir, context_window):
  verify_snapshot(model_dir)
  # Register only the digest-verified architecture; never execute the downloaded
  # launcher, enable trust_remote_code, or accept request-controlled model paths.
  architecture = model_dir / "kolibri1.py"
  spec = importlib.util.spec_from_file_location("mlx_lm.models.kolibri1", architecture)
  module = importlib.util.module_from_spec(spec)
  sys.modules[spec.name] = module
  try:
    spec.loader.exec_module(module)
  except Exception:
    sys.modules.pop(spec.name, None)
    raise
  from mlx_lm import load, stream_generate
  from mlx_lm.sample_utils import make_sampler

  model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
  return KolibriRuntime(model, tokenizer, stream_generate, make_sampler, context_window)


class KolibriHandler(BaseHTTPRequestHandler):
  protocol_version = "HTTP/1.1"

  def log_message(self, *args):
    # The upstream server's request/error logging can contain prompts and paths.
    pass

  def send_error(self, code, message=None, explain=None):
    self.error(ContractError("REQUEST_INVALID", "The HTTP request is unsupported.", code))

  def error(self, error):
    self.reply(error.status, {"error": {"code": error.code, "message": str(error)}})

  def reply(self, status, body):
    data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Connection", "close")
    self.end_headers()
    self.wfile.write(data)
    self.close_connection = True

  def admit(self):
    if self.headers.get_all("Host") != ["127.0.0.1:" + str(self.server.server_port)] or self.headers.get_all("Origin"):
      raise ContractError("REQUEST_FORBIDDEN", "Only direct loopback requests are supported.", 403)
    self.connection.settimeout(30)

  def do_GET(self):
    try:
      self.admit()
      if self.path == "/v1/models":
        self.reply(200, {"object": "list", "data": [{"id": MODEL_ALIAS, "object": "model", "context_window": self.server.runtime.context_window}]})
      elif self.path == "/health":
        self.reply(200, {"status": "ok"})
      else:
        raise ContractError("ROUTE_UNKNOWN", "The requested route is unsupported.", 404)
    except ContractError as error:
      self.error(error)
    except (BrokenPipeError, ConnectionResetError):
      self.close_connection = True
    except Exception:
      self.error(ContractError("MODEL_UNAVAILABLE", "Kolibri could not complete the request.", 503))

  def do_POST(self):
    try:
      self.admit()
      if self.path != "/v1/chat/completions":
        raise ContractError("ROUTE_UNKNOWN", "The requested route is unsupported.", 404)
      lengths = self.headers.get_all("Content-Length")
      if self.headers.get_all("Transfer-Encoding") or not lengths or len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal():
        raise ContractError("REQUEST_INVALID", "Supply one bounded Content-Length header.")
      length = integer(int(lengths[0]), 1, MAX_REQUEST_BYTES, "The request body size")
      if self.headers.get_all("Content-Type") != ["application/json"]:
        raise ContractError("REQUEST_INVALID", "Use application/json for the request body.")
      raw_body = self.rfile.read(length)
      if len(raw_body) != length:
        raise ContractError("REQUEST_INVALID", "The request body is incomplete.")
      try:
        body = json.loads(raw_body.decode("utf-8"), parse_constant=reject_json_constant, object_pairs_hook=json_object)
      except (ValueError, UnicodeError):
        raise ContractError("REQUEST_INVALID", "The request body must be valid UTF-8 JSON.") from None
      request = validate_request(body, self.server.max_tokens)
      text, finish_reason, usage = self.server.runtime.complete(request)
      base = {"id": "chatcmpl-" + uuid.uuid4().hex, "model": MODEL_ALIAS, "created": int(time.time())}
      if request["stream"]:
        self.stream_reply(base, text, finish_reason, usage, request["include_usage"])
      else:
        self.reply(200, {**base, "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish_reason}], "usage": usage})
    except ContractError as error:
      self.error(error)
    except (BrokenPipeError, ConnectionResetError):
      self.close_connection = True
    except Exception:
      self.error(ContractError("MODEL_UNAVAILABLE", "Kolibri could not complete the request.", 503))

  def stream_reply(self, base, text, finish_reason, usage, include_usage):
    self.send_response(200)
    self.send_header("Content-Type", "text/event-stream")
    self.send_header("Cache-Control", "no-cache")
    self.send_header("Connection", "close")
    self.end_headers()
    # Buffer generation before exposing success so malformed model output never
    # becomes a partially accepted text or tool response.
    def emit(choice, usage_value=None):
      packet = {**base, "object": "chat.completion.chunk", "choices": choice}
      if usage_value is not None:
        packet["object"] = "chat.completion"
        packet["usage"] = usage_value
      self.wfile.write(("data: " + json.dumps(packet, ensure_ascii=False) + "\n\n").encode("utf-8"))
    emit([{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}])
    for offset in range(0, len(text), 256):
      emit([{"index": 0, "delta": {"content": text[offset:offset + 256]}, "finish_reason": None}])
    emit([{"index": 0, "delta": {}, "finish_reason": finish_reason}])
    if include_usage:
      emit([], usage)
    self.wfile.write(b"data: [DONE]\n\n")
    self.wfile.flush()
    self.close_connection = True


class KolibriServer(ThreadingHTTPServer):
  def server_bind(self):
    # HTTPServer normally performs reverse DNS even for loopback. This server
    # has a fixed local identity and never needs a resolver or network lookup.
    socketserver.TCPServer.server_bind(self)
    self.server_name = "127.0.0.1"
    self.server_port = self.server_address[1]

  def handle_error(self, request, client_address):
    # Socket/write failures must not reach the stdlib traceback printer.
    pass


def serve(runtime, port, max_tokens):
  with KolibriServer(("127.0.0.1", port), KolibriHandler) as server:
    server.daemon_threads = True
    server.runtime = runtime
    server.max_tokens = max_tokens
    print("Kolibri text server ready on IPv4 loopback.", flush=True)
    server.serve_forever()


def main(argv=None):
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--model-dir", required=True, type=Path, help="Directory for the exact pinned snapshot (never another model).")
  parser.add_argument("--download", action="store_true", help="Explicitly download the pinned public snapshot into --model-dir.")
  parser.add_argument("--port", type=int, default=8080)
  parser.add_argument("--context-window", type=int, default=DEFAULT_CONTEXT_WINDOW)
  parser.add_argument("--max-tokens", type=int, default=1024)
  args = parser.parse_args(argv)
  try:
    integer(args.port, 1024, 65535, "The server port")
    integer(args.context_window, 1024, MAX_CONTEXT_WINDOW, "The context window")
    integer(args.max_tokens, 1, min(2048, args.context_window - 1), "The output token limit")
    check_runtime()
    sys.dont_write_bytecode = True
    os.umask(0o077)
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    logging.disable(logging.CRITICAL)
    warnings.filterwarnings("ignore")
    if args.download:
      print("Downloading the pinned public Kolibri snapshot.", flush=True)
      download_snapshot(args.model_dir)
    print("Verifying the pinned Kolibri snapshot and loading the model.", flush=True)
    # Library warnings and load diagnostics can include private local paths.
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
      runtime = load_runtime(args.model_dir, args.context_window)
    serve(runtime, args.port, args.max_tokens)
  except KeyboardInterrupt:
    return 0
  except ContractError as error:
    print(error.code + ": " + str(error), file=sys.stderr)
    return 1
  except Exception:
    print("KOLIBRI_START_FAILED: Verify the isolated runtime, pinned snapshot and available loopback port.", file=sys.stderr)
    return 1
  return 0


if __name__ == "__main__":
  raise SystemExit(main())

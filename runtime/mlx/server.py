#!/usr/bin/env python3
"""Start exactly one verified profile; local control belongs to its manager."""

import argparse
import contextlib
import json
import logging
import os
import re
import sys
import threading
import warnings
from pathlib import Path

from kolibri import ContractError, KolibriHandler, KolibriServer, check_runtime, json_object, reject_json_constant
from model_store import load_profile_runtime, read_json


class ProfileHandler(KolibriHandler):
  def do_GET(self):
    try:
      self.admit()
      if self.path == self.server.control_path + "/health":
        self.reply(200, {"schemaVersion": 1, "instanceId": self.server.instance_id, "profileDigest": self.server.profile["profileDigest"], "pid": os.getpid()})
      elif self.path == "/v1/models":
        profile = self.server.profile
        self.reply(200, {"object": "list", "data": [{"id": profile["alias"], "object": "model", "context_window": profile["contextWindow"], "capabilities": {**self.server.runtime.capabilities, "mlxProfileDigest": "sha256:" + profile["profileDigest"], "mlxMaxOutputTokens": self.server.max_tokens}}]})
      else:
        super().do_GET()
    except ContractError as error:
      self.error(error)
    except (BrokenPipeError, ConnectionResetError):
      self.close_connection = True
    except Exception:
      self.error(ContractError("MODEL_UNAVAILABLE", "The local MLX runtime is unavailable.", 503))

  def do_POST(self):
    if self.path != self.server.control_path + "/shutdown":
      return super().do_POST()
    try:
      self.admit()
      if self.headers.get("Transfer-Encoding") is not None or self.headers.get_all("Content-Length") not in (None, ["0"]):
        raise ContractError("INVALID_REQUEST", "The management request must have no body.", 400)
      if not self.server.runtime.lock.acquire(blocking=False):
        raise ContractError("MODEL_BUSY", "The model is handling a request; retry after it completes.", 409)
      try:
        self.reply(200, {"schemaVersion": 1, "instanceId": self.server.instance_id, "profileDigest": self.server.profile["profileDigest"], "stopping": True})
      finally:
        # Once admitted, shutdown is terminal even if the acknowledgement disconnects.
        threading.Thread(target=self.server.shutdown, daemon=True).start()
    except ContractError as error:
      self.error(error)
    except (BrokenPipeError, ConnectionResetError):
      self.close_connection = True


def main(argv=None):
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--profile", required=True, type=Path)
  parser.add_argument("--port", type=int, default=0)
  args = parser.parse_args(argv)
  os.umask(0o077)
  sys.dont_write_bytecode = True
  os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
  os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
  os.environ["MLXLM_USE_MODELSCOPE"] = "False"
  logging.disable(logging.CRITICAL)
  warnings.filterwarnings("ignore")
  try:
    if args.port != 0 and not 1024 <= args.port <= 65535:
      raise ValueError()
    check_runtime()
    control = json.loads(sys.stdin.buffer.read(4097).decode("utf-8"), object_pairs_hook=json_object, parse_constant=reject_json_constant)
    if not isinstance(control, dict) or set(control) != {"schemaVersion", "instanceId", "capability"} or control["schemaVersion"] != 1 or not isinstance(control["instanceId"], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", control["instanceId"]) or not isinstance(control["capability"], str) or not re.fullmatch(r"[0-9a-f]{64}", control["capability"]):
      raise ValueError()
    profile = read_json(args.profile)
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
      runtime = load_profile_runtime(profile)
    with KolibriServer(("127.0.0.1", args.port), ProfileHandler) as server:
      server.daemon_threads = True
      server.runtime = runtime
      server.max_tokens = profile["maxOutputTokens"]
      server.profile = profile
      server.instance_id = control["instanceId"]
      server.control_path = "/_pickermux/" + control["capability"]
      print(json.dumps({"schemaVersion": 1, "ready": True, "port": server.server_port, "profileDigest": profile["profileDigest"]}), flush=True)
      server.serve_forever()
    return 0
  except KeyboardInterrupt:
    return 0
  except Exception:
    print(json.dumps({"schemaVersion": 1, "ready": False, "code": "MLX_RUNTIME_UNAVAILABLE"}), flush=True)
    return 1


if __name__ == "__main__":
  raise SystemExit(main())

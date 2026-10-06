#!/usr/bin/env python3
"""Finite stdin/stdout protocol for the optional isolated MLX model manager."""

import contextlib
import json
import logging
import os
import sys
import warnings
from pathlib import Path

from kolibri import ContractError, check_runtime, json_object, reject_json_constant
from model_store import import_kolibri, operation_lock, plan_model, prepare_model, read_json, verify_profile


def execute(request):
  if not isinstance(request, dict) or request.get("schemaVersion") != 1:
    raise ValueError()
  action = request.get("action")
  if action == "plan" and set(request) == {"schemaVersion", "action", "spec", "directory"}:
    directory = Path(request["directory"])
    with operation_lock(directory):
      return plan_model(request["spec"], directory)
  if action == "prepare" and set(request) == {"schemaVersion", "action", "plan", "directory"}:
    directory = Path(request["directory"])
    with operation_lock(directory):
      return prepare_model(request["plan"], directory)
  if action == "import" and set(request) == {"schemaVersion", "action", "spec", "directory"}:
    return import_kolibri(request["spec"], Path(request["directory"]))
  if action == "verify" and set(request) == {"schemaVersion", "action", "profile"}:
    verify_profile(request["profile"])
    return {"verified": True}
  raise ValueError()


def main():
  os.umask(0o077)
  sys.dont_write_bytecode = True
  os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
  os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
  os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
  os.environ["MLXLM_USE_MODELSCOPE"] = "False"
  logging.disable(logging.CRITICAL)
  warnings.filterwarnings("ignore")
  try:
    check_runtime()
    source = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(source) > 1024 * 1024:
      raise ValueError()
    request = json.loads(source.decode("utf-8"), object_pairs_hook=json_object, parse_constant=reject_json_constant)
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
      result = execute(request)
    print(json.dumps({"schemaVersion": 1, "ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
    return 0
  except Exception as error:
    code = error.code if isinstance(error, ContractError) else "MLX_MODEL_INVALID"
    print(json.dumps({"schemaVersion": 1, "ok": False, "code": code}))
    return 1


if __name__ == "__main__":
  raise SystemExit(main())

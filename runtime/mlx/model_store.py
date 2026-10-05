"""Immutable, private Hugging Face model profiles without remote Python code."""

import hashlib
import contextlib
import fcntl
import importlib
import json
import os
import re
import stat
from pathlib import Path

from kolibri import ContractError, MODEL_ALIAS, MODEL_REPOSITORY, MODEL_REVISION, MODEL_SHA256, RUNTIME_VERSIONS, TOOL_PROTOCOL, canonical_digest, check_runtime, digest_file, json_object, reject_json_constant


PROFILE_KIND = "pickermux-mlx-profile"
DATA_FILES = {"config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "tokenizer.model", "vocab.json", "merges.txt", "chat_template.jinja", "model.safetensors.index.json", "LICENSE"}
NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
WEIGHT_PATTERN = re.compile(r"model(?:-\d{5}-of-\d{5})?\.safetensors\Z")
MAX_FILES = 256
MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024 * 1024
MAX_METADATA_BYTES = 32 * 1024 * 1024


def fail(message="The MLX model profile or snapshot could not be verified."):
  raise ContractError("MLX_MODEL_INVALID", message)


def canonical(value):
  return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def identity(profile):
  return {key: value for key, value in profile.items() if key not in ("profileDigest", "snapshotDirectory")}


def profile_digest(profile):
  return hashlib.sha256(canonical(identity(profile))).hexdigest()


def private_directory(directory):
  info = directory.lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    fail("MLX model directories must be private and owned by the current user.")


def private_file(file, limit=None):
  info = file.lstat()
  if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or (limit is not None and info.st_size > limit):
    fail("MLX model files must be private, singly linked and owned by the current user.")
  return info


def read_json(file):
  info = private_file(file, MAX_METADATA_BYTES)
  descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
  with os.fdopen(descriptor, "rb") as source:
    opened = os.fstat(source.fileno())
    if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink, opened.st_mode, opened.st_uid) != (info.st_dev, info.st_ino, info.st_size, info.st_nlink, info.st_mode, info.st_uid):
      fail()
    data = source.read(MAX_METADATA_BYTES + 1)
    after = os.fstat(source.fileno())
    if len(data) > MAX_METADATA_BYTES or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
      fail()
  return json.loads(data.decode("utf-8"), object_pairs_hook=json_object, parse_constant=reject_json_constant)


@contextlib.contextmanager
def operation_lock(directory):
  private_directory(directory)
  cache = directory / ".cache"
  cache.mkdir(mode=0o700, exist_ok=True)
  private_directory(cache)
  file = cache / "pickermux-model-operation.lock"
  descriptor = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
  try:
    info = private_file(file)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
      fail()
    try:
      fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
      raise ContractError("MLX_MODEL_BUSY", "The snapshot is still being prepared by another helper.") from None
    yield
  finally:
    os.close(descriptor)


def validate_spec(spec):
  if not isinstance(spec, dict) or set(spec) - {"repository", "revision", "alias", "contextWindow", "maxOutputTokens"}:
    fail()
  repository = spec.get("repository")
  if not isinstance(repository, str) or len(repository) > 255 or len(repository.split("/")) != 2 or not all(NAME_PATTERN.fullmatch(part) and part not in (".", "..") for part in repository.split("/")):
    fail("Supply an exact Hugging Face owner/model repository.")
  revision = spec.get("revision", "main")
  if not isinstance(revision, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}", revision) or ".." in revision:
    fail("Supply a bounded Hugging Face revision.")
  if not isinstance(spec.get("alias"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", spec["alias"]):
    fail("Supply a lowercase model alias.")
  if type(spec.get("contextWindow")) is not int or not 1024 <= spec["contextWindow"] <= 8192:
    fail("The configured context window must be between 1024 and 8192 tokens.")
  if type(spec.get("maxOutputTokens")) is not int or not 1 <= spec["maxOutputTokens"] <= min(2048, spec["contextWindow"] - 1):
    fail("The output token limit is outside the supported bounds.")
  return {**spec, "revision": revision}


def supported_architecture(config, tokenizer_config, custom=False, class_resolver=None):
  for value in (config, tokenizer_config):
    if not isinstance(value, dict) or any(value.get(key) is not None for key in ("model_file", "auto_map")):
      fail("Models requiring remote Python code are unsupported.")
  # Transformers preserves tokenizer-config file overrides even when a local
  # snapshot supplied resolved filenames. Keep every such read inside this inventory.
  for key, value in tokenizer_config.items():
    if key.endswith("_file") and value is not None and (not isinstance(value, str) or value not in DATA_FILES):
      fail("Tokenizer file overrides must name verified files inside the snapshot.")
  fast_files = tokenizer_config.get("fast_tokenizer_files")
  if fast_files is not None and (not isinstance(fast_files, list) or any(name != "tokenizer.json" for name in fast_files)):
    fail("Versioned tokenizer files outside the verified inventory are unsupported.")
  model_type = config.get("model_type")
  if not isinstance(model_type, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", model_type):
    fail("The model architecture is unsupported.")
  for key in ("chat_template_type", "tool_parser_type"):
    parser = tokenizer_config.get(key)
    if parser is not None and (not isinstance(parser, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", parser)):
      fail("The tokenizer requests an unsupported parser.")
  if custom:
    if model_type != "kolibri1":
      fail()
  else:
    if class_resolver is None:
      from mlx_lm.utils import _get_classes
      class_resolver = _get_classes
    classes = class_resolver(config)
    if not isinstance(classes, tuple) or len(classes) != 2 or any(not getattr(value, "__module__", "").startswith("mlx_lm.models.") for value in classes):
      fail("Only installed built-in MLX-LM architectures are supported.")
  return model_type


def validate_context(config, tokenizer_config, context_window):
  bounds = []
  for source, names in ((config, ("max_position_embeddings", "n_positions", "max_sequence_length", "seq_length")), (tokenizer_config, ("model_max_length",))):
    for name in names:
      value = source.get(name)
      if type(value) is int and 0 < value <= 1000000000:
        bounds.append(value)
  if not bounds or context_window > min(bounds):
    fail("The requested context exceeds the model's declared context bound or no bound is available.")


def validate_weights(directory, names):
  weights = {name for name in names if WEIGHT_PATTERN.fullmatch(name)}
  if not weights:
    fail()
  if "model.safetensors" in weights:
    if len(weights) != 1:
      fail("The snapshot mixes incompatible weight layouts.")
  else:
    parts = [re.fullmatch(r"model-(\d{5})-of-(\d{5})\.safetensors", name) for name in weights]
    totals = {int(part.group(2)) for part in parts}
    if len(totals) != 1 or totals != {len(parts)} or {int(part.group(1)) for part in parts} != set(range(1, len(parts) + 1)):
      fail("The snapshot has missing or inconsistent weight shards.")
  index = directory / "model.safetensors.index.json"
  if index.exists():
    parsed = read_json(index)
    mapping = parsed.get("weight_map") if isinstance(parsed, dict) else None
    if not isinstance(mapping, dict) or not mapping or len(mapping) > 100000 or any(not isinstance(value, str) for value in mapping.values()) or set(mapping.values()) != weights:
      fail("The weight index does not match the immutable file inventory.")


def expected_file(file, expected):
  info = private_file(file)
  if info.st_size != expected["bytes"]:
    fail()
  sha256 = hashlib.sha256()
  git_sha1 = hashlib.sha1(("blob " + str(info.st_size) + "\0").encode("ascii"))
  descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
  with os.fdopen(descriptor, "rb") as source:
    opened = os.fstat(source.fileno())
    if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink, opened.st_mode, opened.st_uid) != (info.st_dev, info.st_ino, info.st_size, info.st_nlink, info.st_mode, info.st_uid):
      fail()
    for part in iter(lambda: source.read(8 * 1024 * 1024), b""):
      sha256.update(part)
      git_sha1.update(part)
    after = os.fstat(source.fileno())
    if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
      fail()
  actual = sha256.hexdigest() if expected["hashKind"] == "sha256" else git_sha1.hexdigest() if expected["hashKind"] == "git-sha1" else None
  if actual != expected["hash"]:
    fail("The immutable model snapshot is missing or modified.")
  return sha256.hexdigest()


def safe_inventory(directory, names, allow_missing=False):
  private_directory(directory)
  allowed = set(names) | {".cache"}
  if any(entry.name not in allowed for entry in directory.iterdir()):
    fail("The snapshot contains unexpected files.")
  cache = directory / ".cache"
  if cache.exists() or cache.is_symlink():
    private_directory(cache)
    for entry in cache.rglob("*"):
      if entry.is_symlink() or (not entry.is_file() and not entry.is_dir()):
        fail()
      if entry.is_dir():
        private_directory(entry)
      else:
        info = entry.lstat()
        # HF lock files deliberately use shared mode bits. Private owned ancestor
        # directories still prevent other users from reaching these auxiliary files.
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
          fail()
  for name in names:
    file = directory / name
    if allow_missing and not file.exists() and not file.is_symlink():
      continue
    private_file(file)


def plan_model(spec, directory, api=None, download_file=None, class_resolver=None):
  spec = validate_spec(spec)
  if api is None:
    from huggingface_hub import HfApi, hf_hub_download
    api = HfApi()
    download_file = hf_hub_download
  info = api.model_info(spec["repository"], revision=spec["revision"], files_metadata=True, token=False)
  revision = info.sha
  if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision) or info.id != spec["repository"]:
    fail("The repository did not resolve to an exact immutable model revision.")
  custom = spec["repository"] == MODEL_REPOSITORY and revision == MODEL_REVISION
  entries = []
  for sibling in info.siblings:
    name = sibling.rfilename
    if name not in DATA_FILES and not WEIGHT_PATTERN.fullmatch(name):
      continue
    if len(entries) >= MAX_FILES or type(sibling.size) is not int or not 0 <= sibling.size <= (MAX_METADATA_BYTES if name in DATA_FILES else MAX_SNAPSHOT_BYTES):
      fail()
    lfs = sibling.lfs
    if lfs is not None:
      digest = lfs.sha256 if hasattr(lfs, "sha256") else lfs.get("sha256")
      hash_kind = "sha256"
      if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail()
    else:
      digest = sibling.blob_id
      hash_kind = "git-sha1"
      if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{40}", digest):
        fail()
    entries.append({"name": name, "bytes": sibling.size, "hashKind": hash_kind, "hash": digest})
  if custom:
    architecture = next((item for item in info.siblings if item.rfilename == "kolibri1.py"), None)
    if architecture is None:
      fail()
    entries.append({"name": "kolibri1.py", "bytes": architecture.size, "hashKind": "sha256", "hash": MODEL_SHA256["kolibri1.py"]})
    for entry in entries:
      if entry["name"] not in MODEL_SHA256:
        fail()
      entry.update(hashKind="sha256", hash=MODEL_SHA256[entry["name"]])
  entries.sort(key=lambda entry: entry["name"])
  names = [entry["name"] for entry in entries]
  if len(set(names)) != len(names) or not {"config.json", "tokenizer_config.json"}.issubset(names) or not any(WEIGHT_PATTERN.fullmatch(name) for name in names) or sum(item["bytes"] for item in entries) > MAX_SNAPSHOT_BYTES:
    fail("The repository does not contain a supported bounded MLX snapshot.")
  if custom and set(names) != set(MODEL_SHA256):
    fail()
  safe_inventory(directory, names, allow_missing=True)
  for entry in entries:
    file = directory / entry["name"]
    if file.exists():
      expected_file(file, entry)
  for name in ("config.json", "tokenizer_config.json"):
    download_file(spec["repository"], name, revision=revision, local_dir=str(directory), token=False)
    expected_file(directory / name, next(entry for entry in entries if entry["name"] == name))
  config, tokenizer_config = read_json(directory / "config.json"), read_json(directory / "tokenizer_config.json")
  model_type = supported_architecture(config, tokenizer_config, custom, class_resolver)
  validate_context(config, tokenizer_config, spec["contextWindow"])
  return {"schemaVersion": 1, "repository": spec["repository"], "revision": revision, "alias": spec["alias"], "contextWindow": spec["contextWindow"], "maxOutputTokens": spec["maxOutputTokens"], "modelType": model_type, "customArchitecture": "kolibri1" if custom else None, "runtimeVersions": RUNTIME_VERSIONS, "files": entries}


def validate_plan(plan):
  required = {"schemaVersion", "repository", "revision", "alias", "contextWindow", "maxOutputTokens", "modelType", "customArchitecture", "runtimeVersions", "files"}
  if not isinstance(plan, dict) or set(plan) != required or plan["schemaVersion"] != 1 or plan["runtimeVersions"] != RUNTIME_VERSIONS or not isinstance(plan["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", plan["revision"]):
    fail()
  validate_spec({key: plan[key] for key in ("repository", "revision", "alias", "contextWindow", "maxOutputTokens")})
  custom = plan["repository"] == MODEL_REPOSITORY and plan["revision"] == MODEL_REVISION
  if plan["customArchitecture"] != ("kolibri1" if custom else None) or not isinstance(plan["modelType"], str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", plan["modelType"]):
    fail()
  files = plan["files"]
  if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
    fail()
  names = []
  for entry in files:
    if not isinstance(entry, dict) or set(entry) != {"name", "bytes", "hashKind", "hash"} or not isinstance(entry["name"], str) or (entry["name"] not in DATA_FILES and not WEIGHT_PATTERN.fullmatch(entry["name"]) and not (custom and entry["name"] == "kolibri1.py")) or type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= MAX_SNAPSHOT_BYTES or entry["hashKind"] not in ("sha256", "git-sha1") or not isinstance(entry["hash"], str) or not re.fullmatch(r"[0-9a-f]{64}" if entry["hashKind"] == "sha256" else r"[0-9a-f]{40}", entry["hash"]):
      fail()
    if custom and (entry["hashKind"] != "sha256" or MODEL_SHA256.get(entry["name"]) != entry["hash"]):
      fail()
    names.append(entry["name"])
  if len(set(names)) != len(names) or sum(entry["bytes"] for entry in files) > MAX_SNAPSHOT_BYTES or not {"config.json", "tokenizer_config.json"}.issubset(names) or not any(WEIGHT_PATTERN.fullmatch(name) for name in names) or (custom and set(names) != set(MODEL_SHA256)):
    fail()
  return plan


def prepare_model(plan, directory, downloader=None):
  validate_plan(plan)
  if downloader is None:
    from huggingface_hub import snapshot_download
    downloader = snapshot_download
  names = [entry["name"] for entry in plan["files"]]
  safe_inventory(directory, names, allow_missing=True)
  for entry in plan["files"]:
    file = directory / entry["name"]
    if file.exists():
      expected_file(file, entry)
  downloader(repo_id=plan["repository"], revision=plan["revision"], local_dir=str(directory), allow_patterns=names, token=False)
  return profile_from_plan(plan, directory)


def profile_from_plan(plan, directory):
  validate_plan(plan)
  names = [entry["name"] for entry in plan["files"]]
  safe_inventory(directory, names)
  validate_weights(directory, names)
  files = []
  for entry in plan["files"]:
    file = directory / entry["name"]
    actual_sha256 = expected_file(file, entry)
    files.append({"name": entry["name"], "bytes": entry["bytes"], "sha256": actual_sha256})
  profile = {**plan, "kind": PROFILE_KIND, "files": files, "snapshotDirectory": str(directory.absolute())}
  profile["profileDigest"] = profile_digest(profile)
  return profile


def import_kolibri(spec, directory):
  from kolibri import verify_snapshot
  spec = validate_spec(spec)
  if spec["repository"] != MODEL_REPOSITORY or spec["revision"] not in ("main", MODEL_REVISION):
    fail("Only the exact pinned Kolibri snapshot can be imported.")
  verify_snapshot(directory)
  plan = {"schemaVersion": 1, "repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "alias": spec["alias"], "contextWindow": spec["contextWindow"], "maxOutputTokens": spec["maxOutputTokens"], "modelType": "kolibri1", "customArchitecture": "kolibri1", "runtimeVersions": RUNTIME_VERSIONS, "files": [{"name": name, "bytes": (directory / name).stat().st_size, "hashKind": "sha256", "hash": digest} for name, digest in sorted(MODEL_SHA256.items())]}
  return profile_from_plan(plan, directory)


def verify_profile(profile, class_resolver=None):
  required = {"schemaVersion", "kind", "repository", "revision", "alias", "contextWindow", "maxOutputTokens", "modelType", "customArchitecture", "runtimeVersions", "files", "snapshotDirectory", "profileDigest"}
  if not isinstance(profile, dict) or set(profile) != required or profile["kind"] != PROFILE_KIND or profile["schemaVersion"] != 1 or profile["runtimeVersions"] != RUNTIME_VERSIONS or not isinstance(profile["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", profile["revision"]) or profile_digest(profile) != profile["profileDigest"]:
    fail()
  validate_spec({key: profile[key] for key in ("repository", "revision", "alias", "contextWindow", "maxOutputTokens")})
  custom = profile["repository"] == MODEL_REPOSITORY and profile["revision"] == MODEL_REVISION
  if profile["customArchitecture"] != ("kolibri1" if custom else None):
    fail()
  files = profile["files"]
  if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
    fail()
  names = []
  for entry in files:
    if not isinstance(entry, dict) or set(entry) != {"name", "bytes", "sha256"} or not isinstance(entry["name"], str) or (entry["name"] not in DATA_FILES and not WEIGHT_PATTERN.fullmatch(entry["name"]) and not (custom and entry["name"] == "kolibri1.py")) or type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= MAX_SNAPSHOT_BYTES or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
      fail()
    if custom and MODEL_SHA256.get(entry["name"]) != entry["sha256"]:
      fail()
    names.append(entry["name"])
  if len(set(names)) != len(names) or sum(entry["bytes"] for entry in files) > MAX_SNAPSHOT_BYTES or not {"config.json", "tokenizer_config.json"}.issubset(names) or not any(WEIGHT_PATTERN.fullmatch(name) for name in names) or (custom and set(names) != set(MODEL_SHA256)):
    fail()
  if not isinstance(profile["snapshotDirectory"], str):
    fail()
  directory = Path(profile["snapshotDirectory"])
  if not directory.is_absolute():
    fail()
  safe_inventory(directory, names)
  validate_weights(directory, names)
  for entry in files:
    expected_file(directory / entry["name"], {"bytes": entry["bytes"], "hashKind": "sha256", "hash": entry["sha256"]})
  config, tokenizer_config = read_json(directory / "config.json"), read_json(directory / "tokenizer_config.json")
  validate_context(config, tokenizer_config, profile["contextWindow"])
  if profile["modelType"] != supported_architecture(config, tokenizer_config, custom, class_resolver):
    fail()
  return directory


def managed_runtime_fingerprint(directory=None):
  source = Path(__file__).parent if directory is None else directory
  return canonical_digest({"protocol": TOOL_PROTOCOL, "versions": RUNTIME_VERSIONS, "runtimeFiles": {name: digest_file(source / name) for name in ("kolibri.py", "manage.py", "model_store.py", "server.py")}})


def load_profile_runtime(profile):
  from kolibri import KolibriRuntime
  directory = verify_profile(profile)
  custom = profile["customArchitecture"] == "kolibri1"
  if custom:
    import importlib.util
    import sys
    spec = importlib.util.spec_from_file_location("mlx_lm.models.kolibri1", directory / "kolibri1.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
      spec.loader.exec_module(module)
    except Exception:
      sys.modules.pop(spec.name, None)
      raise
  from mlx_lm import load, stream_generate
  from mlx_lm.sample_utils import make_sampler
  model, tokenizer = load(str(directory), tokenizer_config={"trust_remote_code": False, "local_files_only": True}, trust_remote_code=False)
  runtime = KolibriRuntime(model, tokenizer, stream_generate, make_sampler, profile["contextWindow"], model_alias=profile["alias"], tool_capable=custom)
  if custom:
    runtime.capabilities = {**runtime.capabilities, "runtimeFingerprint": managed_runtime_fingerprint()}
  return runtime

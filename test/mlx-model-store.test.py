import hashlib
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime" / "mlx"))
from kolibri import ContractError, KolibriServer
from model_store import plan_model, prepare_model, verify_profile, validate_plan, validate_spec, supported_architecture, profile_digest, operation_lock, validate_weights, managed_runtime_fingerprint, RUNTIME_VERSIONS
from server import ProfileHandler
from manage import execute


class StoreTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory(prefix="pickermux-mlx-offline-")
    self.addCleanup(self.temp.cleanup)
    self.directory = Path(self.temp.name)
    self.spec = {"repository": "example/Test-MLX", "revision": "main", "alias": "test-mlx", "contextWindow": 8192, "maxOutputTokens": 1024}
    self.files = {"config.json": json.dumps({"model_type": "llama", "max_position_embeddings": 8192}).encode(), "tokenizer_config.json": json.dumps({"model_max_length": 8192}).encode(), "model.safetensors": b"offline weights"}
    self.classes = (type("Model", (), {"__module__": "mlx_lm.models.llama"}), type("ModelArgs", (), {"__module__": "mlx_lm.models.llama"}))

  def plan(self):
    siblings = [SimpleNamespace(rfilename=name, size=len(value), lfs=None, blob_id=hashlib.sha1(b"blob " + str(len(value)).encode() + b"\0" + value).hexdigest()) for name, value in self.files.items()]
    siblings.append(SimpleNamespace(rfilename="remote_code.py", size=1, lfs=None, blob_id="f" * 40))
    def download(repository, name, **kwargs):
      self.assertEqual(repository, self.spec["repository"])
      self.assertEqual(kwargs["revision"], "a" * 40)
      self.assertIs(kwargs["token"], False)
      self.assertNotEqual(name, "remote_code.py")
      file = self.directory / name
      file.write_bytes(self.files[name])
      file.chmod(0o600)
    api = SimpleNamespace(model_info=lambda *args, **kwargs: SimpleNamespace(id=self.spec["repository"], sha="a" * 40, siblings=siblings))
    return plan_model(self.spec, self.directory, api=api, download_file=download, class_resolver=lambda config: self.classes)

  def prepared(self):
    plan = self.plan()
    def download(**kwargs):
      self.assertEqual(kwargs["revision"], "a" * 40)
      self.assertIs(kwargs["token"], False)
      self.assertEqual(set(kwargs["allow_patterns"]), set(self.files))
      for name in kwargs["allow_patterns"]:
        file = self.directory / name
        file.write_bytes(self.files[name])
        file.chmod(0o600)
    return prepare_model(plan, self.directory, downloader=download)

  def test_exact_pinned_download_and_profile_digest(self):
    profile = self.prepared()
    self.assertEqual(profile["revision"], "a" * 40)
    self.assertEqual(profile["profileDigest"], profile_digest(profile))
    self.assertEqual(verify_profile(profile, class_resolver=lambda config: self.classes), self.directory)
    self.assertFalse((self.directory / "remote_code.py").exists())
    relocated = {**profile, "snapshotDirectory": "/different/private/location"}
    self.assertEqual(profile_digest(relocated), profile["profileDigest"])

  def test_no_remote_python_or_unsafe_architecture(self):
    for config in ({"model_type": "../unsafe"}, {"model_type": "llama", "auto_map": {"AutoModel": "remote_code.Model"}}, {"model_type": "llama", "model_file": "remote_code.py"}):
      with self.assertRaises(ContractError):
        supported_architecture(config, {}, class_resolver=lambda value: self.fail("resolver must not run"))
    with self.assertRaises(ContractError):
      supported_architecture({"model_type": "llama"}, {}, class_resolver=lambda value: (type("Unsafe", (), {"__module__": "remote_code"}), self.classes[1]))
    self.files["tokenizer_config.json"] = b'{"auto_map":{"AutoTokenizer":"remote_code.Tokenizer"}}'
    with self.assertRaises(ContractError):
      self.plan()

  def test_tokenizer_cannot_redirect_reads_outside_snapshot(self):
    for tokenizer in ({"tokenizer_file": "/outside/tokenizer.json"}, {"vocab_file": "../vocab.json"}, {"merges_file": "https://untrusted.example/merges.txt"}, {"fast_tokenizer_files": ["tokenizer.99.json"]}):
      with self.assertRaises(ContractError):
        supported_architecture({"model_type": "llama"}, tokenizer, class_resolver=lambda value: self.fail("must reject before loading tokenizer"))

  def test_context_claim_fails_closed(self):
    self.files["config.json"] = b'{"model_type":"llama","max_position_embeddings":4096}'
    with self.assertRaises(ContractError):
      self.plan()

  def test_declared_native_context_262144_is_accepted_and_changes_profile_identity(self):
    self.files["config.json"] = b'{"model_type":"llama","max_position_embeddings":262144}'
    self.files["tokenizer_config.json"] = b'{"model_max_length":262144}'
    conservative = self.prepared()
    self.spec["contextWindow"] = 262144
    expanded = self.prepared()
    self.assertEqual(expanded["contextWindow"], 262144)
    self.assertEqual(verify_profile(expanded, class_resolver=lambda config: self.classes), self.directory)
    self.assertNotEqual(expanded["profileDigest"], conservative["profileDigest"])
    with self.assertRaises(ContractError):
      verify_profile({**conservative, "contextWindow": 262144}, class_resolver=lambda config: self.classes)

  def test_context_above_ceiling_or_declared_bound_is_rejected(self):
    with self.assertRaises(ContractError):
      validate_spec({**self.spec, "contextWindow": 262145})
    self.spec["contextWindow"] = 262144
    self.files["config.json"] = b'{"model_type":"llama","max_position_embeddings":262144}'
    self.files["tokenizer_config.json"] = b'{"model_max_length":65536}'
    with self.assertRaises(ContractError):
      self.plan()
    self.files["config.json"] = b'{"model_type":"llama","max_position_embeddings":65536}'
    self.files["tokenizer_config.json"] = b'{"model_max_length":262144}'
    with self.assertRaises(ContractError):
      self.plan()
    self.files["config.json"] = b'{"model_type":"llama"}'
    self.files["tokenizer_config.json"] = b'{}'
    with self.assertRaises(ContractError):
      self.plan()

  def test_hash_changes_and_links_are_rejected_before_download(self):
    plan = self.plan()
    (self.directory / "model.safetensors").write_bytes(b"changed")
    (self.directory / "model.safetensors").chmod(0o600)
    with self.assertRaises(ContractError):
      prepare_model(plan, self.directory, downloader=lambda **kwargs: self.fail("must not overwrite changed data"))
    (self.directory / "model.safetensors").unlink()
    (self.directory / "model.safetensors").symlink_to(self.directory / "config.json")
    with self.assertRaises(ContractError):
      prepare_model(plan, self.directory, downloader=lambda **kwargs: self.fail("must not follow links"))

  def test_profile_and_pending_plan_unknown_fields_rejected(self):
    profile = self.prepared()
    modified = {**profile, "contextWindow": 4096}
    with self.assertRaises(ContractError):
      verify_profile(modified, class_resolver=lambda config: self.classes)
    plan = self.plan()
    with self.assertRaises(ContractError):
      validate_plan({**plan, "trust_remote_code": True})
    with self.assertRaises(ContractError):
      validate_plan({**plan, "revision": "main"})
    with self.assertRaises(ValueError):
      execute({"schemaVersion": 1, "action": "verify", "profile": profile, "extra": True})

  def test_concurrent_or_surviving_helper_cannot_mutate_same_snapshot(self):
    with operation_lock(self.directory):
      with self.assertRaises(ContractError):
        with operation_lock(self.directory):
          self.fail("concurrent helper must not be admitted")
    with operation_lock(self.directory):
      pass

  def test_missing_and_mixed_weight_shards_are_rejected(self):
    for names in (("model.safetensors", "model-00001-of-00001.safetensors"), ("model-00001-of-00002.safetensors",), ("model-00002-of-00002.safetensors", "model-00003-of-00002.safetensors")):
      with self.assertRaises(ContractError):
        validate_weights(self.directory, names)

  def test_hf_auxiliary_lock_modes_stay_inside_private_directories(self):
    cache = self.directory / ".cache"
    cache.mkdir(mode=0o700)
    lock = cache / "hf.lock"
    lock.write_bytes(b"")
    lock.chmod(0o664)
    self.prepared()
    cache.chmod(0o755)
    with self.assertRaises(ContractError):
      self.plan()

  def test_managed_runtime_fingerprint_binds_all_packaged_modules(self):
    for name in ("kolibri.py", "manage.py", "model_store.py", "server.py"):
      (self.directory / name).write_text("offline runtime " + name)
    original = managed_runtime_fingerprint(self.directory)
    self.assertRegex(original, r"^sha256:[0-9a-f]{64}$")
    (self.directory / "server.py").write_text("changed runtime handler")
    self.assertNotEqual(managed_runtime_fingerprint(self.directory), original)

  def test_nonprivate_snapshot_rejected(self):
    self.directory.chmod(0o755)
    with self.assertRaises(ContractError):
      self.plan()


class ProfileServerTests(unittest.TestCase):
  def test_models_identity_private_health_and_owned_shutdown(self):
    with KolibriServer(("127.0.0.1", 0), ProfileHandler) as server:
      server.runtime = SimpleNamespace(capabilities={}, lock=threading.Lock())
      server.profile = {"alias": "test-mlx", "contextWindow": 4096, "profileDigest": "a" * 64}
      server.max_tokens = 1024
      server.instance_id = "12345678-1234-4234-8234-123456789abc"
      server.control_path = "/_pickermux/" + "b" * 64
      server.daemon_threads = True
      thread = threading.Thread(target=server.serve_forever, daemon=True)
      thread.start()
      def request(method, route, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        connection.request(method, route, headers=headers or {})
        reply = connection.getresponse()
        result = reply.status, json.loads(reply.read())
        connection.close()
        return result
      try:
        status, data = request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(data["data"][0]["capabilities"], {"mlxProfileDigest": "sha256:" + "a" * 64, "mlxMaxOutputTokens": 1024})
        self.assertEqual(request("GET", "/_pickermux/wrong/health")[0], 404)
        health = request("GET", server.control_path + "/health")[1]
        self.assertEqual(health["pid"], os.getpid())
        self.assertEqual(request("GET", server.control_path + "/health", {"Origin": "https://untrusted.example"})[0], 403)
        server.runtime.lock.acquire()
        self.assertEqual(request("POST", server.control_path + "/shutdown")[0], 409)
        server.runtime.lock.release()
        self.assertEqual(request("POST", server.control_path + "/shutdown")[0], 200)
        thread.join(3)
        self.assertFalse(thread.is_alive())
      finally:
        server.shutdown()
        thread.join(3)

  def test_shutdown_acknowledgement_disconnect_still_stops(self):
    events = []
    handler = object.__new__(ProfileHandler)
    handler.server = SimpleNamespace(control_path="/private", runtime=SimpleNamespace(lock=threading.Lock()), instance_id="fixture", profile={"profileDigest": "a" * 64}, shutdown=lambda: events.append("stopped"))
    handler.path = "/private/shutdown"
    handler.headers = http.client.HTTPMessage()
    handler.admit = lambda: None
    def disconnected(*args):
      raise BrokenPipeError()
    handler.reply = disconnected
    handler.do_POST()
    for thread in threading.enumerate():
      if thread is not threading.current_thread() and thread.name.startswith("Thread"):
        thread.join(1)
    self.assertEqual(events, ["stopped"])
    self.assertTrue(handler.close_connection)


if __name__ == "__main__":
  unittest.main()

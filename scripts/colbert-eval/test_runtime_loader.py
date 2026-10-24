"""Stdlib synthetic checks only; never imports an inference dependency."""
import sys
sys.dont_write_bytecode = True

import builtins
import copy
import hashlib
import importlib.abc
import importlib.util
import json
import math
import pathlib
import struct
import subprocess
import unittest
from contextlib import nullcontext
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock, patch

import adapter
import runtime_loader as loader

ROOT = pathlib.Path(__file__).resolve().parent
BLOCKED = {"torch", "pylate", "transformers", "sentence_transformers", "numpy", "safetensors", "tokenizers"}


class DenyFrameworks(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in BLOCKED:
            raise AssertionError("Forbidden inference import: " + fullname)


sys.meta_path.insert(0, DenyFrameworks())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checkpoint(tensors):
    header, offset = {}, 0
    for name, shape in tensors.items():
        count = math.prod(shape) * 4
        header[name] = {"dtype": "F32", "shape": list(shape), "data_offsets": [offset, offset + count]}
        offset += count
    raw = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack("<Q", len(raw)) + raw + b"\x00" * offset


def synthetic_bundle():
    lock = json.loads((ROOT / "runtime-lock.json").read_text())
    artifacts, records = lock["model"]["artifacts"], {}
    for path, spec in artifacts.items():
        if path == "model.safetensors":
            data = checkpoint({"embeddings.weight": (2, 256)})
        elif path == "1_Dense/model.safetensors":
            data = checkpoint({"linear.weight": (512, 256)})
        elif path == "2_Dense/model.safetensors":
            data = checkpoint({"linear.weight": (48, 512)})
        elif path == "tokenizer.json":
            data = b'{"synthetic":true}'
        else:
            data = json.dumps(spec["content"], separators=(",", ":")).encode()
        spec.update(bytes=len(data), sha256=sha(data))
        records[path] = loader.MemoryArtifact.regular(path, data)
    digest = adapter.projection_chain_digest({p: artifacts[p]["sha256"] for p in adapter.PROJECTION_FILES})
    lock["model"]["projectionSha256"] = digest
    contract = {
        "modelId": adapter.MODEL_ID, "revision": loader.MODEL_REVISION,
        "weightsSha256": artifacts["model.safetensors"]["sha256"],
        "tokenizerSha256": artifacts["tokenizer.json"]["sha256"], "projectionSha256": digest,
        "backend": "torch-cpu", "precision": "float32", "dimensions": 48,
        "queryMaxTokens": 32, "documentMaxTokens": 512, "preparation": "gmax-token-ids-v1",
        "normalization": "per-token-l2", "documentStorage": "int8-per-document-maxabs-127",
    }
    return lock, records, contract


class Tensor:
    def __init__(self, data, dtype="float32", device="cpu", shape=None):
        self.data, self.dtype, self.device = copy.deepcopy(data), dtype, device
        def dimensions(value):
            return (len(value),) + dimensions(value[0]) if isinstance(value, (list, tuple)) and value else ()
        self.shape = shape if shape is not None else dimensions(data)

    def tolist(self):
        def lists(value):
            return [lists(x) for x in value] if isinstance(value, (list, tuple)) else value
        return lists(self.data)

    def detach(self):
        return self

    def cpu(self):
        return Tensor(self.data, self.dtype, "cpu", self.shape)


class Identity:
    pass


class FakeModel:
    def __init__(self, device="cpu", dtype="float32", attention="eager"):
        self.params = {
            "0.auto_model.embeddings.weight": Tensor([], dtype, device, (2, 256)),
            "1.linear.weight": Tensor([], dtype, device, (512, 256)),
            "2.linear.weight": Tensor([], dtype, device, (48, 512)),
        }
        config = SimpleNamespace(model_type="modernbert", hidden_size=256,
                                 _attn_implementation=attention, reference_compile=False)
        encoder = SimpleNamespace(auto_model=SimpleNamespace(config=config))
        def head(name, in_features, out_features):
            return SimpleNamespace(in_features=in_features, out_features=out_features,
                linear=SimpleNamespace(weight=self.params[name + ".linear.weight"], bias=None),
                activation_function=Identity(), use_residual=False)
        self.children = [("0", encoder), ("1", head("1", 256, 512)), ("2", head("2", 512, 48))]
        self.device, self.dtype = device, dtype
        self.seen = []
        self.output_device = self.output_dtype = None
        self.output_shape = None
        self.fail_forward = False
        self.transform = None
        self.to_calls = []
        self.evaluated = False

    def named_children(self):
        return iter(self.children)

    def named_parameters(self):
        return iter(self.params.items())

    def state_dict(self):
        return dict(self.params)

    def to(self, *, device, dtype):
        self.to_calls.append((device, dtype))
        return self

    def eval(self):
        self.evaluated = True
        return self

    def forward(self, features):
        if self.fail_forward:
            raise RuntimeError("synthetic forward failure")
        self.seen.append(copy.deepcopy(features))
        ids = features["input_ids"].tolist()
        # Observable synthetic rows preserve batch/token order, including supplied
        # zero-mask positions. This is not a model or simulated model quality.
        data = [[[float(token), float(b)] + [0.0] * 46 for token in row] for b, row in enumerate(ids)]
        result = dict(features, token_embeddings=Tensor(data, self.output_dtype or self.dtype,
            self.output_device or self.device, self.output_shape))
        return self.transform(result) if self.transform else result


def fake_provider(model):
    torch, pylate = Mock(), Mock()
    torch.__version__, pylate.__version__ = loader.API_VERSIONS["torch"], loader.API_VERSIONS["pylate"]
    torch.float32, torch.float16, torch.int64 = "float32", "float16", "int64"
    torch.tensor.side_effect = lambda data, dtype, device: Tensor(data, dtype, device)
    torch.inference_mode.side_effect = nullcontext
    torch.backends.mps.is_available.return_value = True
    pylate.models.ColBERT.return_value = model
    return loader.MockRuntimeProvider(torch, pylate, dict(loader.API_VERSIONS), Mock(),
                                      {"PYTORCH_ENABLE_MPS_FALLBACK": "0"})


class LoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = synthetic_bundle()

    def setUp(self):
        self.lock = copy.deepcopy(self.bundle[0])
        self.reader = loader.MemoryArtifactReader(self.bundle[1])
        self.contract = dict(self.bundle[2])
        self.model = FakeModel()
        self.provider = fake_provider(self.model)
        self.inputs = [{"id": "q2", "kind": "query", "inputIds": [7, 8, 9], "attentionMask": [1, 0, 1]},
                       {"id": "d1", "kind": "document", "inputIds": [5], "attentionMask": [0]}]

    def load(self, **kwargs):
        return loader.load_mock_runtime(self.contract, lock=self.lock, reader=self.reader,
            provider=self.provider, local_directory="/synthetic/artifacts", **kwargs)

    def code(self, expected, fn):
        with self.assertRaises(adapter.AdapterError) as ctx:
            fn()
        self.assertEqual(ctx.exception.code, expected)

    def verify(self):
        return loader.verify_mock_artifacts(self.contract, self.lock, self.reader)

    def replace_artifact(self, path, data, content=None):
        self.reader.artifacts[path] = loader.MemoryArtifact.regular(path, data)
        spec = self.lock["model"]["artifacts"][path]
        spec.update(bytes=len(data), sha256=sha(data))
        if content is not None:
            spec["content"] = content

    def test_import_initialization_and_validation_are_framework_free(self):
        script = '''
import builtins, sys
sys.path.insert(0, sys.argv[1])
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.split('.')[0] in {'torch','pylate','transformers','numpy','sentence_transformers','safetensors','tokenizers'}:
        raise AssertionError(name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
import runtime_loader, adapter
with open(sys.argv[1] + '/fixtures/synthetic-validate-request.json') as f:
    import json
    request = json.load(f)
def denied(*args, **kwargs): raise AssertionError('unexpected I/O/import')
builtins.open = denied
builtins.__import__ = denied
assert adapter.handle_request(request)['ok']
for value in (None, True, {'qualified': True}, {'runtimeQualified': True}):
    try: runtime_loader.load_local_runtime(qualification=value)
    except adapter.AdapterError as e: assert e.code == 'runtime_unqualified'
    else: raise AssertionError('real runtime enabled')
assert not any(n.split('.')[0] in {'torch','pylate','transformers','numpy'} for n in sys.modules)
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", script, str(ROOT)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_and_forged_qualification_always_refuse_before_hooks(self):
        for value in (None, True, object(), {"qualified": True}, {"runtimeQualified": True}):
            self.code("runtime_unqualified", lambda: loader.load_local_runtime(
                qualification=value, reader=self.reader, provider=self.provider))
        self.provider.pylate.models.ColBERT.assert_not_called()
        self.assertEqual(self.reader.read_sizes, [])

    def test_proposed_lock_is_not_runtime_or_dependency_qualification(self):
        lock = json.loads((ROOT / "runtime-lock.json").read_text())
        self.assertFalse(lock["runtimeQualified"])
        self.assertFalse(lock["execution"]["enabled"])
        self.assertIn("NOT-resolved", lock["kind"])
        self.assertTrue(lock["unresolvedGates"])
        self.assertEqual(lock["mockApiVersions"], dict(loader.API_VERSIONS))
        for spec in lock["dependencies"].values():
            self.assertIsNone(spec["selectedDistributionSha256"])
            self.assertFalse(spec["distributionFilesFetched"])
        up = json.loads((ROOT / "upstream-mixedbread.json").read_text())
        self.assertEqual(lock["model"]["revision"], up["revision"])
        self.assertEqual(lock["model"]["projectionSha256"], up["projection"]["expectedAggregateSha256"])
        for path, digest in up["projection"]["orderedArtifacts"]:
            self.assertEqual(lock["model"]["artifacts"][path]["sha256"], digest)
        self.assertNotIn("2_Dense/2_Dense/model.safetensors", lock["model"]["artifacts"])

    def test_hashes_and_tensor_map_are_from_bounded_injected_bytes(self):
        evidence = self.verify()
        self.assertFalse(evidence["runtimeQualified"])
        self.assertEqual(evidence["tensorShapes"], {
            "0.auto_model.embeddings.weight": (2, 256),
            "1.linear.weight": (512, 256), "2.linear.weight": (48, 512)})
        self.assertLessEqual(max(self.reader.read_sizes), loader.CHUNK_BYTES)

    def test_missing_each_required_artifact(self):
        for path in loader.ARTIFACT_PATHS:
            reader = loader.MemoryArtifactReader(self.bundle[1])
            del reader.artifacts[path]
            self.code("artifact_missing", lambda: loader.verify_mock_artifacts(self.contract, self.lock, reader))
        self.provider.pylate.models.ColBERT.assert_not_called()

    def test_wrong_backbone_projection_and_tokenizer_hashes(self):
        for path in ("model.safetensors", "1_Dense/model.safetensors", "2_Dense/model.safetensors", "tokenizer.json", "tokenizer_config.json"):
            reader = loader.MemoryArtifactReader(self.bundle[1])
            rec = reader.artifacts[path]
            reader.artifacts[path] = replace(rec, data=rec.data[:-1] + bytes([rec.data[-1] ^ 1]))
            self.code("artifact_mismatch", lambda: loader.verify_mock_artifacts(self.contract, self.lock, reader))

    def test_missing_original_artifacts_do_not_accept_onnx_names(self):
        self.reader.artifacts["model_int8.onnx"] = self.reader.artifacts.pop("model.safetensors")
        self.code("artifact_layout", self.verify)

    def test_mutation_size_identity_and_hardlink_refuse(self):
        path = "model.safetensors"
        original = self.reader.artifacts[path]
        for rec in (replace(original, after=(1, 2, len(original.data), 1, 1, 1)),
                    replace(original, before=(1, 1, len(original.data) + 1, 1, 1, 1)),
                    replace(original, before=(1, 1, len(original.data), 1, 1, 2))):
            self.reader.artifacts[path] = rec
            self.code("artifact_mutated", self.verify)

    def test_symlink_file_directory_and_root_refuse(self):
        path = "1_Dense/model.safetensors"
        original = self.reader.artifacts[path]
        for kinds in (("symlink", "file"), ("directory", "symlink"), ("directory", "directory")):
            self.reader.artifacts[path] = replace(original, component_kinds=kinds)
            self.code("artifact_symlink", self.verify)
        self.reader.artifacts[path] = original
        self.reader.root_kinds = ("directory", "symlink")
        self.code("artifact_symlink", self.verify)

    def test_traversal_absolute_empty_and_backslash_paths_refuse(self):
        for path in ("../weights", "/weights", "a//b", "a/./b", "a/../b", "a\\b", "a\x00b"):
            lock = copy.deepcopy(self.lock)
            lock["model"]["artifacts"][path] = {}
            self.code("artifact_path", lambda: loader.verify_mock_artifacts(self.contract, lock, self.reader))
        for root in ("relative", "/synthetic/../cache", "/synthetic/./cache"):
            self.code("artifact_path", lambda: loader.load_mock_runtime(self.contract, lock=self.lock,
                reader=self.reader, provider=self.provider, local_directory=root))

    def test_manifest_bounds_and_unknown_duplicate_projection_refuse(self):
        for value in (-1, True, loader.MAX_FILE_BYTES + 1):
            self.lock["model"]["artifacts"]["config.json"]["bytes"] = value
            self.code("artifact_bound", self.verify)
        self.lock = copy.deepcopy(self.bundle[0])
        self.lock["model"]["artifacts"]["2_Dense/2_Dense/model.safetensors"] = {}
        self.code("artifact_layout", self.verify)

    def test_hash_and_revision_contract_mismatch(self):
        for key in ("weightsSha256", "tokenizerSha256", "projectionSha256"):
            original = self.contract[key]
            self.contract[key] = "0" * 64
            self.code("artifact_mismatch", self.verify)
            self.contract[key] = original
        self.contract["revision"] = "0" * 40
        self.code("artifact_mismatch", self.verify)

    def test_projection_order_config_and_duplicate_head_refuse(self):
        original = self.lock["model"]["artifacts"]["modules.json"]["content"]
        for modules in ([original[0], original[2], original[1]], original + [original[2]], original[:2]):
            raw = json.dumps(modules).encode()
            self.replace_artifact("modules.json", raw, modules)
            self.code("projection_unverified", self.verify)

    def test_projection_tensor_shape_bias_and_metadata_refuse(self):
        for tensors in ({"linear.weight": (48, 256)},
                        {"linear.weight": (48, 512), "linear.bias": (48,)},
                        {"other.weight": (48, 512)}):
            self.replace_artifact("2_Dense/model.safetensors", checkpoint(tensors))
            self.code("checkpoint_layout", self.verify)
        self.replace_artifact("2_Dense/model.safetensors", b"\xff" * 8)
        self.code("checkpoint_layout", self.verify)

    def test_malformed_checkpoint_headers_and_ranges_refuse(self):
        headers = [b'{}', b'{"x":{"dtype":"F16","shape":[1],"data_offsets":[0,4]}}',
            b'{"x":{"dtype":"F32","shape":[1],"data_offsets":[1,5]}}',
            b'{"x":{"dtype":"F32","shape":[true],"data_offsets":[0,4]}}',
            b'{"x":{},"x":{}}']
        for header in headers:
            self.replace_artifact("model.safetensors", struct.pack("<Q", len(header)) + header + b'\x00' * 4)
            self.code("checkpoint_layout" if header != headers[-1] else "artifact_layout", self.verify)

    def test_json_duplicate_nonfinite_and_config_content_refuse(self):
        for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff', b'[]'):
            self.replace_artifact("config.json", data)
            self.code("artifact_layout", self.verify)

    def test_dependency_and_forged_lock_versions_refuse_before_constructor(self):
        for key in loader.API_VERSIONS:
            self.provider.versions[key] = "wrong"
            self.code("dependency_mismatch", self.load)
            self.provider.versions[key] = loader.API_VERSIONS[key]
        self.provider.torch.__version__ = "2.7.0+unreviewed"
        self.code("dependency_mismatch", self.load)
        self.provider.torch.__version__ = "2.7.0"
        self.lock["runtimeQualified"] = True
        self.code("dependency_mismatch", self.load)
        self.provider.pylate.models.ColBERT.assert_not_called()

    def test_non_mock_provider_reader_and_qualification_keyword_refuse(self):
        self.provider = replace(self.provider, torch=SimpleNamespace())
        self.code("mock_only", self.load)
        self.code("mock_only", lambda: loader.MockRuntime(
            self.model, self.provider, self.contract, {}, "eager"))
        self.code("mock_only", lambda: loader.verify_mock_artifacts(self.contract, self.lock, object()))
        with self.assertRaises(TypeError):
            self.load(qualified=True)

    def test_constructor_local_only_precise_kwargs_and_no_dimension_override(self):
        with self.load() as runtime:
            self.assertFalse(runtime.runtime_qualified)
        kwargs = self.provider.pylate.models.ColBERT.call_args.kwargs
        self.assertEqual(kwargs["model_name_or_path"], "/synthetic/artifacts")
        self.assertTrue(kwargs["local_files_only"])
        self.assertFalse(kwargs["trust_remote_code"])
        self.assertNotIn("embedding_size", kwargs)
        self.assertEqual((kwargs["query_length"], kwargs["document_length"]), (32, 512))
        self.assertEqual((kwargs["query_prefix"], kwargs["document_prefix"], kwargs["skiplist_words"]), ("", "", []))
        self.assertFalse(kwargs["do_query_expansion"])
        self.assertFalse(kwargs["truncation"])
        self.assertTrue(kwargs["attend_to_expansion_tokens"])
        for key in ("model_kwargs", "tokenizer_kwargs", "config_kwargs"):
            self.assertTrue(kwargs[key]["local_files_only"])
        self.assertFalse(kwargs["config_kwargs"]["reference_compile"])
        self.assertEqual(kwargs["model_kwargs"]["attn_implementation"], "eager")
        self.assertTrue(self.model.evaluated)
        self.assertEqual(self.model.to_calls, [("cpu", "float32")])
        self.provider.cleanup.assert_called_once_with(self.model)

    def test_cpu_mps_precision_and_attention_matrix_is_mock_only(self):
        for device in ("cpu", "mps"):
            for dtype in ("float32", "float16"):
                for attention in ("eager", "sdpa"):
                    self.contract.update(backend="torch-" + device, precision=dtype)
                    self.model = FakeModel(device, dtype, attention)
                    self.provider = fake_provider(self.model)
                    with self.load(attention=attention) as runtime:
                        rows = runtime.forward_raw(self.inputs, output_ids=["q2", "d1"])
                    self.assertEqual(rows[1][0][:2], (5.0, 1.0))
        self.assertFalse(runtime.runtime_qualified)

    def test_unsupported_precision_and_attention_refuse(self):
        self.contract["precision"] = "bfloat16"
        self.code("unsupported_backend", self.load)
        self.contract["precision"] = "float32"
        for attention in ("flash_attention_2", "auto", None):
            self.code("unsupported_attention", lambda: self.load(attention=attention))
        self.provider.pylate.models.ColBERT.assert_not_called()

    def test_mps_unavailability_fallback_missing_and_enabled_refuse(self):
        self.contract["backend"] = "torch-mps"
        self.provider.torch.backends.mps.is_available.return_value = False
        self.code("device_unverified", self.load)
        self.provider.torch.backends.mps.is_available.return_value = True
        for env in ({}, {"PYTORCH_ENABLE_MPS_FALLBACK": "1"}):
            self.provider = replace(self.provider, environment=env)
            self.code("device_unverified", self.load)
        self.provider.pylate.models.ColBERT.assert_not_called()

    def test_mps_environment_change_after_constructor_refuses(self):
        self.contract["backend"] = "torch-mps"
        self.model = FakeModel("mps")
        self.provider = fake_provider(self.model)
        runtime = self.load()
        self.provider.environment["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
        self.code("device_unverified", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
        self.provider.cleanup.assert_called_once_with(self.model)

    def test_constructor_cpu_fallback_and_parameter_precision_refuse_cleanup(self):
        self.contract["backend"] = "torch-mps"
        self.code("device_mismatch", self.load)
        self.provider.cleanup.assert_called_once_with(self.model)
        self.contract["backend"] = "torch-cpu"
        self.contract["precision"] = "float16"
        self.code("precision_mismatch", self.load)

    def test_loaded_projection_and_complete_state_mapping_refuse(self):
        modifications = [lambda m: m.children.reverse(),
            lambda m: m.children.append(m.children[2]),
            lambda m: setattr(m.children[1][1].linear, "bias", Tensor([])),
            lambda m: setattr(m.children[2][1], "use_residual", True),
            lambda m: setattr(m.children[2][1], "activation_function", object()),
            lambda m: m.params.update({"random.weight": Tensor([], shape=(48, 48))}),
            lambda m: m.params.pop("0.auto_model.embeddings.weight"),
            lambda m: setattr(m.children[0][1].auto_model.config, "reference_compile", True)]
        for modify in modifications:
            self.model = FakeModel()
            self.provider = fake_provider(self.model)
            modify(self.model)
            self.code("checkpoint_layout", self.load)
            self.provider.cleanup.assert_called_once_with(self.model)

    def test_exact_input_tokens_masks_order_and_only_added_padding_removed(self):
        original = copy.deepcopy(self.inputs)
        with self.load() as runtime:
            rows = runtime.forward_raw(self.inputs, output_ids=["q2", "d1"])
        self.assertEqual([len(row) for row in rows], [3, 1])
        self.assertEqual([row[0] for row in rows[0]], [7, 8, 9])
        self.assertEqual(rows[1][0][:2], (5.0, 1.0))
        seen = self.model.seen[0]
        self.assertEqual(seen["input_ids"].tolist(), [[7, 8, 9], [5, 50283, 50283]])
        self.assertEqual(seen["attention_mask"].tolist(), [[1, 0, 1], [0, 0, 0]])
        self.assertEqual(self.inputs, original)
        self.assertEqual(len(adapter.quantize_document(rows[1]).values), 48)

    def test_batch_1_8_16_and_64_keep_order(self):
        for count in (1, 8, 16, 64):
            inputs = [{"id": "d" + str(i), "kind": "document", "inputIds": [i + 1], "attentionMask": [1]} for i in range(count)]
            with self.load() as runtime:
                rows = runtime.forward_raw(inputs, output_ids=[x["id"] for x in inputs])
            self.assertEqual([row[0][0] for row in rows], list(range(1, count + 1)))

    def test_gmax_query32_document512_boundary_no_truncation(self):
        inputs = [{"id": "q", "kind": "query", "inputIds": list(range(32)), "attentionMask": [1] * 32},
                  {"id": "d", "kind": "document", "inputIds": list(range(512)), "attentionMask": [1] * 512}]
        with self.load() as runtime:
            rows = runtime.forward_raw(inputs, output_ids=["q", "d"])
        self.assertEqual([len(row) for row in rows], [32, 512])
        inputs[0]["inputIds"].append(32)
        with self.load() as runtime:
            self.code("invalid_tokens", lambda: runtime.forward_raw(inputs, output_ids=["q", "d"]))

    def test_output_order_shape_missing_and_filtering_refuse_cleanup(self):
        runtime = self.load()
        self.code("output_order_mismatch", lambda: runtime.forward_raw(self.inputs, output_ids=["d1", "q2"]))
        self.provider.cleanup.assert_called_once_with(self.model)
        for shape in ((2, 3, 49), (2, 1, 48), (1, 3, 48)):
            self.model = FakeModel()
            self.provider = fake_provider(self.model)
            self.model.output_shape = shape
            runtime = self.load()
            self.code("output_shape", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
            self.provider.cleanup.assert_called_once_with(self.model)
        self.model = FakeModel()
        self.model.transform = lambda features: {}
        self.provider = fake_provider(self.model)
        runtime = self.load()
        self.code("output_shape", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))

    def test_forward_token_mask_and_device_dtype_mutation_refuse(self):
        for transform in (lambda f: dict(f, attention_mask=Tensor([[1, 1, 1], [0, 0, 0]], "int64")),
                          lambda f: dict(f, input_ids=Tensor([[9, 8, 7], [5, 50283, 50283]], "int64")),
                          lambda f: dict(f, input_ids=Tensor([[7, 8, 9], [5, 50283, 50283]], "float32"))):
            self.model = FakeModel()
            self.model.transform = transform
            self.provider = fake_provider(self.model)
            runtime = self.load()
            self.code("input_tensor_mismatch", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))

    def test_input_tensor_misplacement_precision_and_values_refuse(self):
        for change in (lambda t: setattr(t, "device", "mps"), lambda t: setattr(t, "dtype", "float32"),
                       lambda t: setattr(t, "data", [[9, 9, 9], [5, 50283, 50283]])):
            def tensor(data, dtype, device):
                result = Tensor(data, dtype, device)
                change(result)
                return result
            self.provider = fake_provider(self.model)
            self.provider.torch.tensor.side_effect = tensor
            runtime = self.load()
            self.code("input_tensor_mismatch", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
            self.assertEqual(self.model.seen, [])

    def test_output_device_precision_and_nonfinite_in_added_padding_refuse(self):
        for field, value, code in (("output_device", "mps", "device_mismatch"),
                                   ("output_dtype", "float16", "precision_mismatch")):
            self.model = FakeModel()
            setattr(self.model, field, value)
            self.provider = fake_provider(self.model)
            runtime = self.load()
            self.code(code, lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
        self.model = FakeModel()
        def nonfinite(features):
            features["token_embeddings"].data[1][2][0] = float("nan")
            return features
        self.model.transform = nonfinite
        self.provider = fake_provider(self.model)
        runtime = self.load()
        self.code("nonfinite_vector", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))

    def test_mps_forward_rejects_cpu_input_and_output_fallback(self):
        self.contract["backend"] = "torch-mps"
        for which in ("input", "output"):
            self.model = FakeModel("mps")
            self.provider = fake_provider(self.model)
            if which == "input":
                self.provider.torch.tensor.side_effect = lambda data, dtype, device: Tensor(data, dtype, "cpu")
            else:
                self.model.output_device = "cpu"
            runtime = self.load()
            self.code("input_tensor_mismatch" if which == "input" else "device_mismatch",
                      lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
            self.provider.cleanup.assert_called_once_with(self.model)

    def test_output_data_shape_filtering_is_checked_beyond_reported_shape(self):
        def filter_rows(features):
            features["token_embeddings"].data[0] = features["token_embeddings"].data[0][:2]
            return features
        self.model.transform = filter_rows
        runtime = self.load()
        self.code("invalid_shape", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
        self.provider.cleanup.assert_called_once_with(self.model)

    def test_unlisted_reader_artifacts_and_real_module_objects_refuse(self):
        from types import ModuleType
        self.reader.artifacts["2_Dense/2_Dense/model.safetensors"] = self.reader.artifacts["2_Dense/model.safetensors"]
        self.code("artifact_layout", self.verify)
        self.provider = replace(self.provider, torch=ModuleType("torch"))
        self.code("mock_only", self.load)
        self.provider.pylate.models.ColBERT.assert_not_called()

    def test_forward_parameter_mutation_and_closed_session_refuse(self):
        runtime = self.load()
        self.model.params["2.linear.weight"].device = "mps"
        self.code("device_mismatch", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
        self.code("runtime_closed", lambda: runtime.forward_raw(self.inputs, output_ids=["q2", "d1"]))
        runtime.close()
        self.provider.cleanup.assert_called_once_with(self.model)

    def test_constructor_and_forward_failure_cleanup(self):
        self.provider.pylate.models.ColBERT.side_effect = RuntimeError("synthetic constructor failure")
        with self.assertRaisesRegex(RuntimeError, "synthetic constructor"):
            self.load()
        self.provider.cleanup.assert_called_once_with(None)
        self.provider = fake_provider(self.model)
        self.model.fail_forward = True
        runtime = self.load()
        with self.assertRaisesRegex(RuntimeError, "synthetic forward"):
            runtime.forward_raw(self.inputs, output_ids=["q2", "d1"])
        self.provider.cleanup.assert_called_once_with(self.model)
        runtime.close()
        self.provider.cleanup.assert_called_once()

    def test_no_cli_or_default_adapter_import_edge(self):
        source = (ROOT / "adapter.py").read_text()
        self.assertNotIn("import runtime_loader", source)
        source = (ROOT / "runtime_loader.py").read_text()
        self.assertNotIn('if __name__ == "__main__"', source)
        self.assertFalse(any(name.split(".")[0] in BLOCKED for name in sys.modules))


if __name__ == "__main__":
    unittest.main()

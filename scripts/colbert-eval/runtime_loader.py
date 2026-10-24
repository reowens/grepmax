"""Source-pinned loader preparation. Only injected in-memory mocks can execute.

There is deliberately no framework import, filesystem artifact reader, CLI, or
real qualification issuer. See RUNTIME-LOADER.md before using these test hooks.
"""

import hashlib
import json
import os.path
import struct
from dataclasses import dataclass
from types import MappingProxyType

from adapter import (
    AdapterError, check_actual_device, check_artifact_identity,
    check_projection_layout, local_only_runtime_plan, pad_batch,
    projection_chain_digest, restore_batch_rows, validate_contract, validate_inputs,
)

MODEL_REVISION = "592c6417c1c6687572043408ed1ae5196bce16b1"
API_VERSIONS = MappingProxyType({
    "torch": "2.7.0", "pylate": "1.5.1", "sentence-transformers": "5.3.0",
    "transformers": "4.56.2", "safetensors": "0.6.2",
    "huggingface-hub": "0.34.4", "tokenizers": "0.22.0",
})
ARTIFACT_PATHS = (
    "config.json", "modules.json", "config_sentence_transformers.json",
    "sentence_bert_config.json", "special_tokens_map.json", "tokenizer_config.json",
    "1_Dense/config.json", "2_Dense/config.json", "model.safetensors",
    "tokenizer.json", "1_Dense/model.safetensors", "2_Dense/model.safetensors",
)
CHECKPOINT_MAP = (
    ("model.safetensors", "0.auto_model."),
    ("1_Dense/model.safetensors", "1."),
    ("2_Dense/model.safetensors", "2."),
)
CHUNK_BYTES = 64 * 1024
MAX_FILE_BYTES = 70 * 1024 * 1024
MAX_TOTAL_BYTES = 80 * 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 32 * 1024


def _need(condition, code, message):
    if not condition:
        raise AdapterError(code, message)


def load_local_runtime(*_args, **_kwargs):
    """Always refuse before imports, readers, constructors or caller qualifications.

    A later independently reviewed implementation must establish qualification;
    no object, flag, environment variable, or injected provider enables this API.
    """
    raise AdapterError("RUNTIME_UNQUALIFIED", "Real runtime loading remains unqualified and disabled.")


def _relative(path):
    _need(type(path) is str and path and not path.startswith("/")
          and "\\" not in path and "\x00" not in path
          and all(p not in ("", ".", "..") for p in path.split("/")),
          "ARTIFACT_PATH", "Artifact paths must be canonical relative paths.")
    return path


@dataclass(frozen=True)
class MemoryArtifact:
    """Synthetic reader observations; never evidence about a real filesystem.

    Stamps model (device, inode, size, mtime_ns, ctime_ns, nlink). Component kinds
    include every relative ancestor and the file. Root kinds are on the reader.
    """
    data: bytes
    component_kinds: tuple
    before: tuple
    after: tuple

    @classmethod
    def regular(cls, path, data):
        _relative(path)
        stamp = (1, 1, len(data), 1, 1, 1)
        return cls(data, ("directory",) * path.count("/") + ("file",), stamp, stamp)


class MemoryArtifactReader:
    """Explicit test hook holding bytes only; no open/path/cache/network methods."""
    def __init__(self, artifacts, root_kinds=("directory",)):
        self.artifacts = dict(artifacts)
        self.root_kinds = tuple(root_kinds)
        self.read_sizes = []

    def chunks(self, path):
        _relative(path)
        _need(path in self.artifacts, "ARTIFACT_MISSING", "A required artifact is missing.")
        record = self.artifacts[path]
        _need(type(record) is MemoryArtifact and type(record.data) is bytes,
              "ARTIFACT_READER", "Expected a synthetic immutable byte observation.")
        for offset in range(0, len(record.data), CHUNK_BYTES):
            chunk = record.data[offset:offset + CHUNK_BYTES]
            self.read_sizes.append(len(chunk))
            yield chunk


def _json_bytes(data):
    def pairs(items):
        obj = {}
        for key, value in items:
            _need(key not in obj, "ARTIFACT_LAYOUT", "Duplicate artifact JSON keys are forbidden.")
            obj[key] = value
        return obj
    def nonfinite(_value):
        raise ValueError("nonfinite")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=nonfinite)
    except (ValueError, UnicodeError, RecursionError):
        raise AdapterError("ARTIFACT_LAYOUT", "Artifact JSON is invalid.") from None


def _tensor_header(prefix, file_size):
    _need(len(prefix) >= 8, "CHECKPOINT_LAYOUT", "Checkpoint header is missing.")
    size = struct.unpack("<Q", prefix[:8])[0]
    _need(2 <= size <= MAX_HEADER_BYTES and size + 8 <= len(prefix),
          "CHECKPOINT_LAYOUT", "Checkpoint header exceeds its bounded envelope.")
    header = _json_bytes(prefix[8:size + 8])
    _need(type(header) is dict, "CHECKPOINT_LAYOUT", "Checkpoint header must be an object.")
    result, ranges = {}, []
    for name, spec in header.items():
        if name == "__metadata__":
            _need(type(spec) is dict and all(type(k) is str and type(v) is str for k, v in spec.items()),
                  "CHECKPOINT_LAYOUT", "Checkpoint metadata is invalid.")
            continue
        _need(type(name) is str and name and type(spec) is dict
              and set(spec) == {"dtype", "shape", "data_offsets"} and spec["dtype"] == "F32",
              "CHECKPOINT_LAYOUT", "Expected original float32 checkpoint tensors.")
        shape, offsets = spec["shape"], spec["data_offsets"]
        _need(type(shape) is list and 1 <= len(shape) <= 4
              and all(type(n) is int and 0 < n <= 100000 for n in shape)
              and type(offsets) is list and len(offsets) == 2
              and all(type(n) is int and n >= 0 for n in offsets),
              "CHECKPOINT_LAYOUT", "Checkpoint tensor shapes or offsets are invalid.")
        count = 1
        for n in shape:
            count *= n
        _need(offsets[1] - offsets[0] == count * 4,
              "CHECKPOINT_LAYOUT", "Checkpoint tensor byte size differs from shape.")
        result[name] = tuple(shape)
        ranges.append(tuple(offsets))
    end = 0
    for start, stop in sorted(ranges):
        _need(start == end and stop > start, "CHECKPOINT_LAYOUT", "Checkpoint tensor ranges must be contiguous.")
        end = stop
    _need(result and end + size + 8 == file_size,
          "CHECKPOINT_LAYOUT", "Checkpoint file length differs from its header.")
    return result


def verify_mock_artifacts(contract, lock, reader):
    """Hash bounded injected bytes; validate paths, stamps, configs and tensor maps.

    This verifier exercises real SHA256/JSON/header logic on synthetic bytes. It
    cannot attest that a supplied observation came from an actual local file.
    """
    contract = validate_contract(contract)
    _need(type(reader) is MemoryArtifactReader, "MOCK_ONLY", "Only the explicit in-memory test reader is enabled.")
    _need(type(lock) is dict and lock.get("schemaVersion") == 1
          and lock.get("runtimeQualified") is False and lock.get("mockApiVersions") == dict(API_VERSIONS),
          "DEPENDENCY_MISMATCH", "The proposed API contract is incompatible.")
    model = lock.get("model", {})
    _need(model.get("modelId") == contract["modelId"]
          and model.get("revision") == contract["revision"] == MODEL_REVISION,
          "ARTIFACT_MISMATCH", "The model revision is not the pinned source revision.")
    artifacts = model.get("artifacts", {})
    _need(type(artifacts) is dict, "ARTIFACT_LAYOUT", "Artifact manifest is invalid.")
    for path in artifacts:
        _relative(path)
    _need(set(artifacts) == set(ARTIFACT_PATHS), "ARTIFACT_LAYOUT", "The complete exact artifact set is required.")
    _need(set(reader.artifacts).issubset(set(ARTIFACT_PATHS)),
          "ARTIFACT_LAYOUT", "Unlisted artifact files are forbidden in the synthetic bundle.")
    _need(reader.root_kinds and all(x == "directory" for x in reader.root_kinds),
          "ARTIFACT_SYMLINK", "Every root ancestor must be an observed directory without links.")
    hashes, configs, tensors, total = {}, {}, {}, 0
    for path in ARTIFACT_PATHS:
        expected = artifacts[path]
        _need(type(expected) is dict and type(expected.get("bytes")) is int
              and 0 < expected["bytes"] <= MAX_FILE_BYTES
              and type(expected.get("sha256")) is str and len(expected["sha256"]) == 64
              and all(c in "0123456789abcdef" for c in expected["sha256"]),
              "ARTIFACT_BOUND", "Artifact expectations exceed permitted bounds.")
        total += expected["bytes"]
        _need(total <= MAX_TOTAL_BYTES, "ARTIFACT_BOUND", "Artifact set exceeds its byte bound.")
        _need(path in reader.artifacts, "ARTIFACT_MISSING", "A required artifact is missing.")
        record = reader.artifacts[path]
        _need(type(record) is MemoryArtifact and record.component_kinds ==
              ("directory",) * path.count("/") + ("file",),
              "ARTIFACT_SYMLINK", "Symlinks and non-regular artifact components are forbidden.")
        _need(type(record.before) is tuple and len(record.before) == 6
              and all(type(n) is int and n >= 0 for n in record.before)
              and record.before == record.after and record.before[2] == expected["bytes"]
              and record.before[5] == 1,
              "ARTIFACT_MUTATED", "Artifact identity, size or link count changed.")
        digest, count, prefix = hashlib.sha256(), 0, bytearray()
        capture = MAX_HEADER_BYTES + 8 if path.endswith(".safetensors") else MAX_CONFIG_BYTES
        for chunk in reader.chunks(path):
            count += len(chunk)
            _need(count <= expected["bytes"], "ARTIFACT_BOUND", "Artifact bytes exceed the expected size.")
            digest.update(chunk)
            if len(prefix) < capture:
                prefix.extend(chunk[:capture - len(prefix)])
        _need(count == expected["bytes"] and digest.hexdigest() == expected["sha256"],
              "ARTIFACT_MISMATCH", "Artifact content differs from its pinned identity.")
        hashes[path] = digest.hexdigest()
        if path.endswith(".safetensors"):
            tensors[path] = _tensor_header(bytes(prefix), count)
        elif path != "tokenizer.json":
            _need(count <= MAX_CONFIG_BYTES, "ARTIFACT_BOUND", "Configuration exceeds the JSON bound.")
            configs[path] = _json_bytes(bytes(prefix))
            _need(configs[path] == expected.get("content"),
                  "ARTIFACT_LAYOUT", "Configuration content differs from the source expectation.")
    check_projection_layout(configs["config.json"], configs["modules.json"],
                            [configs["1_Dense/config.json"], configs["2_Dense/config.json"]])
    _need(tensors["1_Dense/model.safetensors"] == {"linear.weight": (512, 256)}
          and tensors["2_Dense/model.safetensors"] == {"linear.weight": (48, 512)},
          "CHECKPOINT_LAYOUT", "Both exact bias-free projection tensors are required.")
    projection = projection_chain_digest({p: hashes[p] for p in (
        "1_Dense/config.json", "1_Dense/model.safetensors", "2_Dense/config.json", "2_Dense/model.safetensors")})
    _need(projection == model.get("projectionSha256"), "ARTIFACT_MISMATCH", "Projection chain identity differs.")
    check_artifact_identity(contract, {"modelId": model["modelId"], "revision": model["revision"],
        "weightsSha256": hashes["model.safetensors"], "tokenizerSha256": hashes["tokenizer.json"],
        "projectionSha256": projection})
    mapping = {prefix + name: shape for path, prefix in CHECKPOINT_MAP for name, shape in tensors[path].items()}
    return {"evidenceKind": "synthetic-injected-bytes-only", "hashes": hashes,
            "configs": configs, "tensorShapes": mapping, "runtimeQualified": False}


@dataclass(frozen=True)
class MockRuntimeProvider:
    """Trusted test code only. torch/pylate/cleanup must be unittest.mock.Mock.

    This is not a security boundary against arbitrary in-process Python code.
    No production module/import provider or automatic fallback is implemented.
    """
    torch: object
    pylate: object
    versions: dict
    cleanup: object
    environment: dict


def _mock_provider(provider):
    from unittest.mock import Mock  # stdlib; never imported on default validation route
    _need(type(provider) is MockRuntimeProvider
          and all(isinstance(x, Mock) for x in (provider.torch, provider.pylate, provider.cleanup)),
          "MOCK_ONLY", "Explicit stdlib mock runtime objects are required.")
    _need(provider.versions == dict(API_VERSIONS)
          and provider.torch.__version__ == API_VERSIONS["torch"]
          and provider.pylate.__version__ == API_VERSIONS["pylate"],
          "DEPENDENCY_MISMATCH", "Injected runtime API versions differ from the proposed pins.")


def _check_mock_mps(provider):
    _need(provider.environment.get("PYTORCH_ENABLE_MPS_FALLBACK") == "0"
          and provider.torch.backends.mps.is_available() is True,
          "DEVICE_UNVERIFIED", "Mock MPS requires availability and explicit fallback refusal.")


def _device(tensor):
    return str(tensor.device)


def _dtype(tensor, torch):
    if tensor.dtype == torch.float32:
        return "float32"
    if tensor.dtype == torch.float16:
        return "float16"
    return "unsupported"


def _parameters(model, contract, torch, mps):
    params = list(model.named_parameters())
    _need(params and len({name for name, _ in params}) == len(params)
          and len({id(tensor) for _, tensor in params}) == len(params),
          "CHECKPOINT_LAYOUT", "Loaded parameters must be named and distinct.")
    expected = "mps" if mps else "cpu"
    check_actual_device(contract, [_device(p) for _, p in params], expected, expected,
                        [_dtype(p, torch) for _, p in params], contract["precision"], mps, mps)


def _layout(model, evidence, attention):
    children = list(model.named_children())
    _need([name for name, _ in children] == ["0", "1", "2"],
          "CHECKPOINT_LAYOUT", "Loaded module order must contain exactly the encoder and two heads.")
    encoder = children[0][1]
    config = encoder.auto_model.config
    _need(config.model_type == "modernbert" and config.hidden_size == 256
          and config._attn_implementation == attention and config.reference_compile is False,
          "CHECKPOINT_LAYOUT", "Encoder configuration or attention implementation changed.")
    for (_, head), shape in zip(children[1:], ((512, 256), (48, 512))):
        _need(head.in_features == shape[1] and head.out_features == shape[0]
              and head.linear.bias is None and tuple(head.linear.weight.shape) == shape
              and type(head.activation_function).__name__ == "Identity" and head.use_residual is False,
              "CHECKPOINT_LAYOUT", "Loaded projection shape, activation, bias or residual changed.")
    state = model.state_dict()
    _need(set(state) == set(evidence["tensorShapes"])
          and all(tuple(state[name].shape) == shape for name, shape in evidence["tensorShapes"].items()),
          "CHECKPOINT_LAYOUT", "Loaded state differs from the complete checkpoint tensor map.")
    _need(set(dict(model.named_parameters())) == set(state),
          "CHECKPOINT_LAYOUT", "Unexpected buffers or missing checkpoint parameters require review.")


class MockRuntime:
    """Mock-only session; returns raw vectors for separate adapter conversion."""
    evidence_kind = "mock-api-only-not-real-inference"
    runtime_qualified = False

    def __init__(self, model, provider, contract, evidence, attention):
        _mock_provider(provider)
        self._model, self._provider = model, provider
        self._contract, self._evidence = dict(contract), evidence
        self._attention = attention

    def close(self):
        model, self._model = self._model, None
        if model is not None:
            self._provider.cleanup(model)

    def __enter__(self):
        _need(self._model is not None, "RUNTIME_CLOSED", "The mock session is closed.")
        return self

    def __exit__(self, *_args):
        self.close()

    def forward_raw(self, inputs, *, output_ids):
        _need(self._model is not None, "RUNTIME_CLOSED", "The mock session is closed.")
        try:
            batch = pad_batch(validate_inputs(inputs, self._contract))
            _need(type(output_ids) in (tuple, list) and tuple(output_ids) == batch.ids,
                  "OUTPUT_ORDER_MISMATCH", "Output identities must match authoritative input order.")
            p, model = self._provider, self._model
            mps = self._contract["backend"] == "torch-mps"
            device = "mps" if mps else "cpu"
            if mps:
                _check_mock_mps(p)
            _layout(model, self._evidence, self._attention)
            _parameters(model, self._contract, p.torch, mps)
            with p.torch.inference_mode():
                feeds = {"input_ids": p.torch.tensor(batch.input_ids, dtype=p.torch.int64, device=device),
                         "attention_mask": p.torch.tensor(batch.attention_mask, dtype=p.torch.int64, device=device)}
                for key, values in (("input_ids", batch.input_ids), ("attention_mask", batch.attention_mask)):
                    tensor = feeds[key]
                    _need(_device(tensor) == device and tensor.dtype == p.torch.int64
                          and tuple(tensor.shape) == (len(batch.ids), len(batch.input_ids[0]))
                          and tensor.tolist() == [list(row) for row in values],
                          "INPUT_TENSOR_MISMATCH", "Input tensors changed device, dtype, order, tokens or masks.")
                # Inherited SentenceTransformer.forward iterates the exact ordered modules;
                # PyLate encode/tokenize/filtering and normalization are bypassed entirely.
                features = model.forward(feeds)
                _need(type(features) is dict and "token_embeddings" in features,
                      "OUTPUT_SHAPE", "Pretokenized forward did not return token embeddings.")
                output = features["token_embeddings"]
                _need(tuple(output.shape) == (len(batch.ids), len(batch.input_ids[0]), 48),
                      "OUTPUT_SHAPE", "Expected raw [batch,sequence,48] vectors.")
                for key, values in (("input_ids", batch.input_ids), ("attention_mask", batch.attention_mask)):
                    _need(key in features and _device(features[key]) == device
                          and features[key].dtype == p.torch.int64
                          and features[key].tolist() == [list(row) for row in values],
                          "INPUT_TENSOR_MISMATCH", "Forward changed or omitted authoritative input features.")
                params = list(model.named_parameters())
                check_actual_device(self._contract, [_device(t) for _, t in params], device, _device(output),
                    [_dtype(t, p.torch) for _, t in params], _dtype(output, p.torch), mps, mps)
                # CPU transfer here is deliberate result extraction, after placement checks.
                rows = output.detach().cpu().tolist()
            return restore_batch_rows(batch, output_ids, rows)
        except BaseException:
            self.close()
            raise


def load_mock_runtime(contract, *, lock, reader, provider, local_directory, attention="eager"):
    """Exercise proposed constructor/forward wiring with explicit fake providers.

    No qualification parameter exists. This hook never imports real frameworks,
    opens artifact paths, or enables load_local_runtime / the validation protocol.
    """
    contract = validate_contract(contract)
    _mock_provider(provider)
    _need(attention in ("eager", "sdpa"), "UNSUPPORTED_ATTENTION", "Only source-checked eager or SDPA is proposed.")
    _need(type(local_directory) is str and os.path.isabs(local_directory)
          and all(p not in (".", "..") for p in local_directory.split("/"))
          and "\\" not in local_directory,
          "ARTIFACT_PATH", "The synthetic artifact root must be a canonical absolute path.")
    mps = contract["backend"] == "torch-mps"
    if mps:
        _check_mock_mps(provider)
    evidence = verify_mock_artifacts(contract, lock, reader)
    c = evidence["configs"]
    plan = local_only_runtime_plan(contract, local_directory, c["config.json"], c["modules.json"],
                                   [c["1_Dense/config.json"], c["2_Dense/config.json"]])
    kwargs = plan["kwargs"]
    kwargs["truncation"] = False
    device = "mps" if mps else "cpu"
    dtype = provider.torch.float32 if contract["precision"] == "float32" else provider.torch.float16
    kwargs["model_kwargs"].update(attn_implementation=attention, torch_dtype=dtype)
    kwargs["config_kwargs"].update(reference_compile=False)
    model = None
    try:
        model = provider.pylate.models.ColBERT(**kwargs)
        # Both saved heads must exist. Never pass embedding_size or synthesize one.
        model.to(device=device, dtype=dtype)
        model.eval()
        _layout(model, evidence, attention)
        _parameters(model, contract, provider.torch, mps)
        return MockRuntime(model, provider, contract, evidence, attention)
    except BaseException:
        # A constructor which raises before returning owns its internal partial
        # allocations; cleanup(None) tells the mock provider to release those too.
        provider.cleanup(model)
        raise

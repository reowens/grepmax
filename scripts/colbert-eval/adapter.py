#!/usr/bin/env python3
"""Wave 1 ColBERT preparation. The JSONL protocol only validates; it never infers.

No optional runtime import, artifact read, tokenizer, or network operation occurs
in this module. Runtime plans describe source-checked arguments, not executable
permission. See ADAPTER.md for the deliberately unqualified runtime boundary.
"""

import hashlib
import json
import math
import os.path
import re
import struct
import sys
from dataclasses import dataclass


MODEL_ID = "mixedbread-ai/mxbai-edge-colbert-v0-17m"
DIMENSIONS = 48
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_INPUTS = 64
MAX_REQUEST_ID = 80
PAD_TOKEN_ID = 50283
MAX_TOKEN_ID = (1 << 31) - 1
CONTRACT_FIELDS = frozenset((
    "modelId", "revision", "weightsSha256", "tokenizerSha256",
    "projectionSha256", "backend", "precision", "dimensions", "queryMaxTokens",
    "documentMaxTokens", "preparation", "normalization", "documentStorage",
))
REQUEST_FIELDS = frozenset(("schemaVersion", "requestId", "operation", "contract", "inputs"))
INPUT_FIELDS = frozenset(("id", "kind", "inputIds", "attentionMask"))


class AdapterError(ValueError):
    """A safe, fixed protocol error; never include request contents in its text."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code.lower()
        self.message = message


def _require(condition, code, message):
    if not condition:
        raise AdapterError(code, message)


def _keys(value, expected, code, message):
    _require(type(value) is dict and set(value) == expected, code, message)


def _identifier(value, maximum=MAX_REQUEST_ID):
    return (type(value) is str
            and re.fullmatch(r"[A-Za-z0-9._-]{1,%d}" % maximum, value) is not None)


def _wire_integer(value):
    # JSON has one numeric type in the parent's JS validator; 1.0 is integral.
    return (type(value) is int or
            (type(value) is float and math.isfinite(value) and value.is_integer()))


def _hex(value, width):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{%d}" % width, value) is not None


def validate_contract(contract):
    """Validate declarations only. Hash strings do not prove any artifact exists."""
    _keys(contract, CONTRACT_FIELDS, "INVALID_CONTRACT", "Contract fields are invalid.")
    _require(contract["modelId"] == MODEL_ID, "UNSUPPORTED_MODEL", "Model identity is unsupported.")
    _require(_hex(contract["revision"], 40), "INVALID_REVISION", "Revision must be 40 hexadecimal characters.")
    for field in ("weightsSha256", "tokenizerSha256", "projectionSha256"):
        _require(_hex(contract[field], 64), "INVALID_ARTIFACT_HASH", "Artifact hashes must be SHA256 hex strings.")
    _require(contract["backend"] in ("torch-cpu", "torch-mps"), "UNSUPPORTED_BACKEND", "Backend is unsupported.")
    _require(contract["precision"] in ("float32", "float16"), "UNSUPPORTED_BACKEND", "Precision is unsupported.")
    for field, expected in (("dimensions", 48), ("queryMaxTokens", 32), ("documentMaxTokens", 512)):
        _require(_wire_integer(contract[field]) and contract[field] == expected,
                 "INCOMPATIBLE_CONTRACT", "Dimensions or token limits are unsupported.")
    for field, expected in (("preparation", "gmax-token-ids-v1"),
                            ("normalization", "per-token-l2"),
                            ("documentStorage", "int8-per-document-maxabs-127")):
        _require(contract[field] == expected, "INCOMPATIBLE_CONTRACT", "Preparation or storage contract is unsupported.")
    return dict(contract)


@dataclass(frozen=True)
class PreparedInput:
    id: str
    kind: str
    input_ids: tuple
    attention_mask: tuple


def validate_inputs(inputs, contract):
    """Snapshot the exact ordered pretokenized sequences; no masking heuristics."""
    contract = validate_contract(contract)
    _require(type(inputs) is list and 1 <= len(inputs) <= MAX_INPUTS,
             "INVALID_INPUTS", "Inputs must contain between 1 and 64 items.")
    seen = set()
    result = []
    for item in inputs:
        _keys(item, INPUT_FIELDS, "INVALID_INPUT", "Input fields are invalid.")
        _require(_identifier(item["id"]), "INVALID_INPUT_ID", "Input ID must contain 1 to 80 ASCII identifier characters.")
        _require(item["id"] not in seen, "INVALID_INPUT_ID", "Input IDs must be unique.")
        seen.add(item["id"])
        _require(item["kind"] in ("query", "document"), "INVALID_INPUT_KIND", "Input kind is unsupported.")
        ids, mask = item["inputIds"], item["attentionMask"]
        limit = contract["queryMaxTokens"] if item["kind"] == "query" else contract["documentMaxTokens"]
        _require(type(ids) is list and 1 <= len(ids) <= limit
                 and all(_wire_integer(token) and 0 <= token <= MAX_TOKEN_ID for token in ids),
                 "INVALID_TOKENS", "Token IDs or token count are invalid.")
        _require(type(mask) is list and len(ids) == len(mask)
                 and all(_wire_integer(bit) and bit in (0, 1) for bit in mask),
                 "INVALID_MASK", "Attention masks must align and contain integer zero or one.")
        result.append(PreparedInput(item["id"], item["kind"],
                                    tuple(int(token) for token in ids), tuple(int(bit) for bit in mask)))
    return tuple(result)


def validate_request(request):
    _keys(request, REQUEST_FIELDS, "INVALID_REQUEST", "Request fields are invalid.")
    _require(_wire_integer(request.get("schemaVersion")) and request["schemaVersion"] == 1,
             "UNSUPPORTED_SCHEMA", "Schema version must be 1.")
    _require(_identifier(request.get("requestId"), MAX_REQUEST_ID), "INVALID_REQUEST_ID",
             "Request ID must contain 1 to 80 ASCII identifier characters.")
    operation = request.get("operation")
    _require(operation == "validate", "INFERENCE_DISABLED", "Only validation is enabled in Wave 1.")
    contract = validate_contract(request["contract"])
    inputs = validate_inputs(request["inputs"], contract)
    encoded = json.dumps(request, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    _require(len(encoded) + 1 <= MAX_FRAME_BYTES, "FRAME_TOO_LARGE", "Frame exceeds the 4 MiB limit.")
    return contract, inputs


def _failure(error, request=None):
    request_id = request.get("requestId") if type(request) is dict else None
    if not _identifier(request_id, MAX_REQUEST_ID):
        request_id = None
    return {"schemaVersion": 1, "requestId": request_id, "ok": False,
            "inferencePerformed": False, "error": {"code": error.code, "message": error.message}}


def handle_request(request):
    """Pure validation entry point. Environment variables cannot enable inference."""
    try:
        contract, inputs = validate_request(request)
        return {"schemaVersion": 1, "requestId": request["requestId"], "ok": True,
                "operation": "validate", "inferencePerformed": False,
                "ids": [item.id for item in inputs], "dimensions": contract["dimensions"]}
    except AdapterError as error:
        return _failure(error, request)


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "INVALID_JSON", "JSON object keys must be unique.")
        result[key] = value
    return result


def _nonfinite_constant(_value):
    raise AdapterError("INVALID_JSON", "JSON must not contain nonfinite constants.")


def decode_frame(frame):
    """Parse one bounded UTF-8 JSON frame, rejecting duplicate keys and NaN."""
    _require(type(frame) is bytes, "INVALID_FRAME", "Frame must contain UTF-8 bytes.")
    _require(0 < len(frame) <= MAX_FRAME_BYTES, "FRAME_TOO_LARGE", "Frame is empty or exceeds the 4 MiB limit.")
    if frame.endswith(b"\n"):
        frame = frame[:-1]
    if frame.endswith(b"\r"):
        frame = frame[:-1]
    _require(b"\n" not in frame and b"\r" not in frame, "INVALID_FRAME", "Expected exactly one JSON line.")
    try:
        line = frame.decode("utf-8")
    except UnicodeError:
        raise AdapterError("INVALID_UTF8", "Protocol frame is not UTF-8.") from None
    try:
        result = json.loads(line, object_pairs_hook=_object_pairs, parse_constant=_nonfinite_constant)
    except (ValueError, RecursionError) as error:
        if isinstance(error, AdapterError):
            raise
        raise AdapterError("INVALID_JSON", "Protocol frame is not valid JSON.") from None
    _require(type(result) is dict, "INVALID_FRAME", "Protocol frame must be an object.")
    return result


def handle_frame(frame):
    try:
        return handle_request(decode_frame(frame))
    except AdapterError as error:
        return _failure(error)


@dataclass(frozen=True)
class PaddedBatch:
    ids: tuple
    kinds: tuple
    input_ids: tuple
    attention_mask: tuple
    lengths: tuple


def pad_batch(inputs, pad_token_id=PAD_TOKEN_ID):
    """Right pad without filtering, expanding, sorting, or changing supplied masks."""
    _require(type(pad_token_id) is int and pad_token_id == PAD_TOKEN_ID,
             "INVALID_PADDING", "Gmax padding requires token ID 50283.")
    _require(type(inputs) in (tuple, list) and 1 <= len(inputs) <= MAX_INPUTS
             and all(type(item) is PreparedInput for item in inputs),
             "INVALID_INPUTS", "Padding requires validated inputs.")
    # Recheck manually constructed PreparedInput values rather than trusting the type.
    validated = validate_inputs([
        {"id": item.id, "kind": item.kind, "inputIds": list(item.input_ids),
         "attentionMask": list(item.attention_mask)} for item in inputs
    ], _synthetic_contract())
    width = max(len(item.input_ids) for item in validated)
    return PaddedBatch(
        tuple(item.id for item in validated), tuple(item.kind for item in validated),
        tuple(item.input_ids + (pad_token_id,) * (width - len(item.input_ids)) for item in validated),
        tuple(item.attention_mask + (0,) * (width - len(item.input_ids)) for item in validated),
        tuple(len(item.input_ids) for item in validated),
    )


def _synthetic_contract():
    # For validating pure helpers only; these placeholders never assert artifact identity.
    return {"modelId": MODEL_ID, "revision": "0" * 40, "weightsSha256": "0" * 64,
            "tokenizerSha256": "0" * 64, "projectionSha256": "0" * 64,
            "backend": "torch-cpu", "precision": "float32", "dimensions": 48,
            "queryMaxTokens": 32, "documentMaxTokens": 512, "preparation": "gmax-token-ids-v1",
            "normalization": "per-token-l2", "documentStorage": "int8-per-document-maxabs-127"}


def _matrix(rows, dimensions):
    _require(type(dimensions) is int and dimensions == DIMENSIONS, "INVALID_DIMENSIONS", "Expected 48 output dimensions.")
    _require(type(rows) in (list, tuple) and bool(rows), "INVALID_VECTORS", "Token vectors must be a nonempty matrix.")
    result = []
    for row in rows:
        _require(type(row) in (list, tuple) and len(row) == dimensions,
                 "INVALID_DIMENSIONS", "Each token vector must have 48 dimensions.")
        _require(all(type(value) in (int, float) for value in row),
                 "INVALID_VECTORS", "Token vectors must be finite numbers.")
        try:
            values = tuple(float(value) for value in row)
        except OverflowError:
            raise AdapterError("NONFINITE_VECTOR", "Token vector values must be finite.") from None
        _require(all(math.isfinite(value) for value in values), "NONFINITE_VECTOR", "Token vector values must be finite.")
        result.append(values)
    return tuple(result)


def normalize_rows(rows, dimensions=DIMENSIONS):
    """Gmax document row L2 math (double accumulation, zero norm uses 1)."""
    result = []
    for row in _matrix(rows, dimensions):
        sum_sq = 0.0
        for value in row:
            sum_sq += value * value
        _require(math.isfinite(sum_sq), "NONFINITE_VECTOR", "Token vector norm must be finite.")
        norm = math.sqrt(sum_sq) or 1.0
        result.append(tuple(value / norm for value in row))
    return tuple(result)


def _float32(value):
    try:
        return struct.unpack("<f", struct.pack("<f", value))[0]
    except (OverflowError, struct.error):
        raise AdapterError("NONFINITE_VECTOR", "Token vector cannot be represented as float32.") from None


@dataclass(frozen=True)
class QuantizedDocument:
    values: tuple  # Flattened signed integers, row major; deliberately not unsigned bytes.
    scale: float  # Gmax stores maxAbs, not maxAbs/127. Decode as q/127*scale.
    rows: int
    dimensions: int


def quantize_document(rows, dimensions=DIMENSIONS):
    """Match colbert.ts document normalization, Float32Array and Math.round order."""
    source = _matrix(rows, dimensions)
    # The existing ONNX document output is float32; model FP16 values are exact in f32.
    normalized = normalize_rows([[_float32(value) for value in row] for row in source], dimensions)
    max_abs = max(abs(value) for row in normalized for value in row) or 1.0
    # JS finds maxVal before assigning normalized[] (Float32Array), then rounds
    # normalized[]/maxVal*127 with ties toward +infinity, unlike Python round().
    stored = tuple(_float32(value) for row in normalized for value in row)
    values = tuple(max(-127, min(127, math.floor((value / max_abs) * 127 + 0.5))) for value in stored)
    return QuantizedDocument(values, max_abs, len(source), dimensions)


def restore_batch_rows(batch, output_ids, vectors, dimensions=DIMENSIONS):
    """Validate ordered synthetic [batch,sequence,48] output and trim added pads.

    Supplied zero-mask positions remain present, as in current Gmax documents.
    This is a pure shape/order utility, not a call to any runtime.
    """
    _require(type(batch) is PaddedBatch, "INVALID_BATCH", "Expected a padded batch.")
    _require(type(output_ids) in (tuple, list) and tuple(output_ids) == batch.ids,
             "OUTPUT_ORDER_MISMATCH", "Output identities or order do not match the input batch.")
    _require(type(vectors) in (tuple, list) and len(vectors) == len(batch.ids),
             "INVALID_SHAPE", "Output batch size does not match the input batch.")
    width = len(batch.input_ids[0])
    result = []
    for index, rows in enumerate(vectors):
        _require(type(rows) in (tuple, list) and len(rows) == width,
                 "INVALID_SHAPE", "Output sequence size does not match the padded batch.")
        checked = _matrix(rows, dimensions)  # Also reject nonfinite values in added padding.
        result.append(checked[:batch.lengths[index]])
    return tuple(result)


def check_actual_device(contract, parameter_devices, input_device, output_device,
                        parameter_precisions, output_precision, mps_available=False,
                        fallback_disabled=False):
    """Pure checks of observations; callers must obtain observations from real tensors.

    Placement alone cannot establish that every MPS op executed on the GPU.
    Mock observations only exercise refusal logic.
    """
    contract = validate_contract(contract)
    expected = "mps" if contract["backend"] == "torch-mps" else "cpu"
    _require(type(parameter_devices) in (list, tuple) and bool(parameter_devices),
             "DEVICE_UNVERIFIED", "Parameter device observations are required.")
    _require(all(device == expected for device in parameter_devices)
             and input_device == expected and output_device == expected,
             "DEVICE_MISMATCH", "Observed tensors must use the explicitly requested device.")
    _require(type(parameter_precisions) in (list, tuple)
             and len(parameter_precisions) == len(parameter_devices)
             and all(dtype == contract["precision"] for dtype in parameter_precisions)
             and output_precision == contract["precision"],
             "PRECISION_MISMATCH", "Observed floating tensor precision must match the contract.")
    if expected == "mps":
        _require(mps_available is True and fallback_disabled is True,
                 "DEVICE_UNVERIFIED", "MPS availability and disabled CPU fallback must be established.")
    return expected


def check_projection_layout(model_config, modules, projection_configs):
    """Check source-observed 256->512->48 metadata, never invent a missing layer.

    This does not establish checkpoint tensor keys, loaded values, or artifact hashes.
    """
    _require(type(model_config) is dict and model_config.get("model_type") == "modernbert"
             and type(model_config.get("hidden_size")) is int and model_config["hidden_size"] == 256,
             "MODEL_MISMATCH", "Expected the ModernBERT 256-dimensional encoder metadata.")
    expected = [
        {"idx": 0, "name": "0", "path": "", "type": "sentence_transformers.models.Transformer"},
        {"idx": 1, "name": "1", "path": "1_Dense", "type": "pylate.models.Dense.Dense"},
        {"idx": 2, "name": "2", "path": "2_Dense", "type": "pylate.models.Dense.Dense"},
    ]
    _require(type(modules) is list and modules == expected
             and all(type(module) is dict and type(module["idx"]) is int for module in modules),
             "PROJECTION_UNVERIFIED", "Expected both declared projection modules in source order.")
    _require(type(projection_configs) in (tuple, list) and len(projection_configs) == 2,
             "PROJECTION_UNVERIFIED", "Both projection configurations are required.")
    for config, shape in zip(projection_configs, ((256, 512), (512, 48))):
        _require(type(config) is dict and config == {
            "in_features": shape[0], "out_features": shape[1], "bias": False,
            "activation_function": "torch.nn.modules.linear.Identity",
        } and type(config["in_features"]) is int and type(config["out_features"]) is int
            and config["bias"] is False,
            "PROJECTION_UNVERIFIED", "Projection dimensions, activation or bias are unverified.")
    return ((256, 512), (512, 48))


def check_artifact_identity(contract, observed):
    """Compare supplied identities without filesystem access or an authenticity claim.

    The producer must verify raw files and the projection_chain_digest recipe
    externally. Equality here only establishes consistency of declarations.
    """
    contract = validate_contract(contract)
    fields = ("modelId", "revision", "weightsSha256", "tokenizerSha256", "projectionSha256")
    _keys(observed, frozenset(fields), "ARTIFACT_UNVERIFIED", "All observed artifact identities are required.")
    _require(all(type(observed[key]) is str and observed[key] == contract[key] for key in fields),
             "ARTIFACT_MISMATCH", "Observed artifact identities differ from the contract.")
    return True


PROJECTION_FILES = (
    "1_Dense/config.json", "1_Dense/model.safetensors",
    "2_Dense/config.json", "2_Dense/model.safetensors",
)


def projection_chain_digest(file_hashes):
    """Hash an ordered raw-file-hash manifest, without opening any artifact.

    SHA256 of UTF-8 JSON.stringify(ordered [relativePath, sha256] pairs), with
    no whitespace or trailing newline. File order is PROJECTION_FILES: both
    projection configs and weights, as selected by modules.json. This matches
    the parent-owned upstream-mixedbread.json recipe. No filename search.
    """
    _keys(file_hashes, frozenset(PROJECTION_FILES), "PROJECTION_UNVERIFIED",
          "The complete ordered projection/config chain is required.")
    _require(all(_hex(file_hashes[path], 64) for path in PROJECTION_FILES),
             "PROJECTION_UNVERIFIED", "Projection chain entries require lowercase SHA256 hex strings.")
    manifest = [[path, file_hashes[path]] for path in PROJECTION_FILES]
    canonical = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def local_only_runtime_plan(contract, local_directory, model_config, modules, projection_configs):
    """Prepare source-checked PyLate arguments without imports, I/O or loading.

    Absolute path syntax is checked, not path existence or provenance. A future
    loader must verify the private local bundle before importing PyLate/Torch.
    No embedding_size override is allowed: PyLate may create a random layer.
    """
    contract = validate_contract(contract)
    _require(type(local_directory) is str and bool(local_directory)
             and os.path.isabs(local_directory) and "\x00" not in local_directory
             and not local_directory.startswith("//"),
             "LOCAL_ARTIFACT_REQUIRED", "A private absolute local artifact directory is required.")
    check_projection_layout(model_config, modules, projection_configs)
    return {"runtimeQualified": False, "inferenceEnabled": False,
            "constructor": "pylate.models.ColBERT",
            "kwargs": {"model_name_or_path": local_directory, "local_files_only": True,
                       "trust_remote_code": False,
                       "device": "mps" if contract["backend"] == "torch-mps" else "cpu",
                       "query_length": 32, "document_length": 512,
                       "query_prefix": "", "document_prefix": "", "do_query_expansion": False,
                       "attend_to_expansion_tokens": True, "skiplist_words": [],
                       "model_kwargs": {"local_files_only": True},
                       "tokenizer_kwargs": {"local_files_only": True},
                       "config_kwargs": {"local_files_only": True}},
            "futureTensorInputs": {"input_ids": "torch.int64", "attention_mask": "torch.int64"},
            "requestedPrecision": contract["precision"],
            "unverified": ["local-artifact-bytes-and-chain-digest", "pinned-runtime-api",
                           "loaded-projection-tensor-values", "pretokenized-forward-output",
                           "actual-device-execution", "normalization-parity"]}


def load_local_runtime(*_args, **_kwargs):
    """No execution permission or forged plan can enable the unqualified loader.

    Later implementation must perform lazy imports here after independent local
    artifact and execution gates. Wave 1 deliberately provides no import hook.
    """
    raise AdapterError("RUNTIME_UNQUALIFIED", "Local runtime loading is unqualified and disabled in Wave 1.")


def serve(input_stream, output_stream):
    """Bound each read and keep stdout protocol-only. Oversize framing is terminal."""
    while True:
        # The frame limit includes its line terminator, matching contract.cjs.
        frame = input_stream.readline(MAX_FRAME_BYTES + 1)
        if not frame:
            return 0
        if len(frame) > MAX_FRAME_BYTES:
            response = _failure(AdapterError("FRAME_TOO_LARGE", "Frame exceeds the 4 MiB limit."))
            terminal = True
        else:
            response = handle_frame(frame)
            terminal = response.get("error", {}).get("code") == "frame_too_large"
        output_stream.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        output_stream.flush()
        if terminal:
            return 1


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args:
        print("Wave 1 accepts JSONL validate requests on stdin; no execution flags are supported.", file=sys.stderr)
        return 2
    return serve(sys.stdin.buffer, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())

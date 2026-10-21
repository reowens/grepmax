"""Pinned text-only backend. Artifact validation uses only the standard library."""
import hashlib
import json
import math
import os
from pathlib import Path
import platform

from prepare_gemma import file_digest, read_header

_CONTRACT_BYTES = (Path(__file__).parent / "gemma-contract.json").read_bytes()
CONTRACT = json.loads(_CONTRACT_BYTES)
CONTRACT_DIGEST = hashlib.sha256(json.dumps(CONTRACT, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
MODEL_ID = CONTRACT["model"]


def validate_artifact(directory):
    directory = Path(directory).absolute()
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Gemma requires an explicit local text-only artifact directory")
    # No aliased directory can redirect a checked path before framework loading.
    if any(parent.is_symlink() for parent in directory.parents):
        raise ValueError("symlink in Gemma artifact path")
    # Loaders inspect more than model/config/tokenizer: encoder subdirectories
    # and legacy tokenizer files can otherwise override a verified identity.
    allowed_files = set(CONTRACT["files"])
    allowed_dirs = {str(parent) for name in allowed_files for parent in Path(name).parents if str(parent) != "."}
    pending, seen, entries = [directory], set(), 0
    while pending:
        for entry in pending.pop().iterdir():
            entries += 1
            relative = entry.relative_to(directory).as_posix()
            if entries > 64 or entry.is_symlink():
                raise ValueError("Unexpected Gemma artifact entry: " + relative)
            if entry.is_dir():
                if relative not in allowed_dirs:
                    raise ValueError("Unexpected Gemma artifact entry: " + relative)
                pending.append(entry)
            elif entry.is_file() and relative in allowed_files:
                seen.add(relative)
            else:
                raise ValueError("Unexpected Gemma artifact entry: " + relative)
    if seen != allowed_files:
        raise ValueError("Gemma artifact file set mismatch")
    for name, expected in CONTRACT["files"].items():
        file = directory / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size > 600 * 1024**2:
            raise ValueError("invalid Gemma artifact file: " + name)
        if file_digest(file) != expected:
            raise ValueError("Gemma artifact digest mismatch: " + name)
    config = json.loads((directory / "config.json").read_text())
    if config.get("model_type") != "embedding_gemma2" or config.get("vision_config") is not None or config.get("audio_config") is not None:
        raise ValueError("Gemma requires the qualified text-only configuration")
    header, _ = read_header(directory / "model.safetensors")
    tensors = {k: v for k, v in header.items() if k != "__metadata__"}
    if (len(tensors) != CONTRACT["tensorCount"] or
        any(not k.startswith("language_model.") or v["dtype"] != "BF16" for k, v in tensors.items()) or
        sum(math.prod(v["shape"]) for v in tensors.values()) != CONTRACT["persistedValues"]):
        raise ValueError("Gemma text tensor inventory mismatch")
    return directory


def load_text_model():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("Gemma backend requires Apple Silicon")
    port = int(os.environ.get("MLX_EMBED_PORT", "8100"))
    if port < 1024 or port > 65535 or port in {8100, 8101, 8079}:
        raise ValueError("Gemma requires a separate MLX_EMBED_PORT, for example 18100")
    location = os.environ.get("GMAX_GEMMA_MODEL_PATH")
    if not location:
        raise ValueError("Set GMAX_GEMMA_MODEL_PATH to the verified local text-only artifact")
    directory = validate_artifact(location)
    # Artifact validation precedes any model/framework imports in this module.
    import importlib.metadata
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_vlm.embedding_loader import load_embedding_model
    from transformers import AutoTokenizer
    if importlib.metadata.version("mlx") != CONTRACT["mlx"] or importlib.metadata.version("transformers") != CONTRACT["transformers"]:
        raise ValueError("Gemma requires its separate locked Python environment")
    distribution = importlib.metadata.distribution("mlx-vlm")
    origin = json.loads(distribution.read_text("direct_url.json") or "{}")
    if origin.get("vcs_info", {}).get("commit_id") != CONTRACT["mlxVlmRevision"]:
        raise ValueError("Gemma requires the pinned MLX-VLM revision")
    mx.set_default_device(mx.gpu)
    model = load_embedding_model(directory)
    if any(getattr(model, key, None) is not None for key in ["audio_tower", "vision_tower", "embed_audio", "embed_vision"]):
        raise ValueError("Gemma modality tower was constructed")
    tensors = tree_flatten(model.parameters())
    if (len(tensors) != CONTRACT["tensorCount"] or
        sum(value.size for _, value in tensors) != CONTRACT["persistedValues"] or
        any(value.dtype != mx.bfloat16 for _, value in tensors)):
        raise ValueError("Gemma loaded tensor inventory mismatch")
    mx.eval(model.parameters())
    tokenizer = AutoTokenizer.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
    return model, tokenizer

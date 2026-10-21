"""Prepare a local text-only BF16 checkpoint without importing or loading a model."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct

MAX_HEADER = 1024 * 1024
MAX_SOURCE = 2 * 1024**3
MAX_OUTPUT = 1024**3
DTYPE_BYTES = {"BF16": 2, "F16": 2, "F32": 4, "F64": 8, "I64": 8, "I32": 4, "I16": 2, "I8": 1, "U8": 1, "BOOL": 1}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def contained(root, value, existing=True):
    root = Path(root).resolve(strict=True)
    value = Path(value).absolute()
    if not value.is_relative_to(root) or value == root:
        raise ValueError("path outside artifact root")
    current = value
    while current != root:
        if current.is_symlink():
            raise ValueError("symlink in artifact path")
        current = current.parent
    resolved = value.resolve(strict=existing)
    if not resolved.is_relative_to(root):
        raise ValueError("canonical path outside artifact root")
    return resolved


def read_header(source):
    size = source.stat().st_size
    if size > MAX_SOURCE or size < 10:
        raise ValueError("checkpoint size outside bound")
    with source.open("rb") as f:
        length = struct.unpack("<Q", f.read(8))[0]
        if length < 2 or length > MAX_HEADER or length + 8 > size:
            raise ValueError("invalid or oversized header")
        header = json.loads(f.read(length), object_pairs_hook=unique_object)
    if not isinstance(header, dict) or len(header) > 2001:
        raise ValueError("invalid tensor inventory")
    ranges = []
    for key, value in header.items():
        if key == "__metadata__":
            continue
        if not isinstance(value, dict):
            raise ValueError("invalid tensor")
        dtype, shape, offsets = value.get("dtype"), value.get("shape"), value.get("data_offsets")
        if dtype not in DTYPE_BYTES or not isinstance(shape, list) or len(shape) > 8:
            raise ValueError("invalid tensor dtype/shape")
        if any(type(n) is not int or n < 0 for n in shape):
            raise ValueError("invalid dimension")
        if not isinstance(offsets, list) or len(offsets) != 2 or any(type(n) is not int for n in offsets):
            raise ValueError("invalid tensor offsets")
        start, end = offsets
        if start < 0 or end < start or end - start != math.prod(shape) * DTYPE_BYTES[dtype] or end > size - length - 8:
            raise ValueError("tensor range/size mismatch")
        ranges.append((start, end))
    previous = 0
    for start, end in sorted(ranges):
        if start != previous:
            raise ValueError("overlapping or incomplete tensor ranges")
        previous = end
    if previous != size - length - 8:
        raise ValueError("unaccounted tensor payload")
    return header, length + 8


def file_digest(file):
    h = hashlib.sha256()
    with file.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def build_text_artifact(root, source, destination):
    source = contained(root, source)
    destination = contained(root, destination, existing=False)
    if not source.is_dir() or destination.exists():
        raise ValueError("source must be a directory and output must be new")
    source_file = contained(root, source / "model.safetensors")
    if file_digest(source_file) != "ffaf2604b011ad0634022529bac930a4f6a2feba22687d8d5890434d186b459c":
        raise ValueError("source is not the qualified pinned EmbeddingGemma 2 BF16 checkpoint")
    header, base = read_header(source_file)
    retained = {key: value for key, value in header.items() if key.startswith("language_model.")}
    if not retained or any(value["dtype"] != "BF16" for value in retained.values()):
        raise ValueError("text weights must be present and BF16")
    size = sum(v["data_offsets"][1] - v["data_offsets"][0] for v in retained.values())
    if size > MAX_OUTPUT:
        raise ValueError("text output exceeds bound")
    staging = destination.with_name(destination.name + ".partial")
    contained(root, staging, existing=False)
    staging.mkdir(parents=True, exist_ok=False)
    # Retain a failed partial for diagnosis. Never publish incomplete output.
    config = json.loads(contained(root, source / "config.json").read_text())
    if config.get("model_type") != "embedding_gemma2":
        raise ValueError("wrong model architecture")
    config["audio_config"] = None
    config["vision_config"] = None
    (staging / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    for relative in ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "tokenizer.model",
                     "config_sentence_transformers.json", "sentence_bert_config.json", "modules.json",
                     "processor_config.json", "preprocessor_config.json", "video_preprocessor_config.json", "chat_template.jinja",
                     "1_Pooling/config.json", "2_Normalize/config.json"]:
        file = source / relative
        if file.exists():
            file = contained(root, file)
            if not file.is_file() or file.stat().st_size > 64 * 1024**2:
                raise ValueError("invalid metadata file")
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
    new_header, offset = {}, 0
    for key, value in sorted(retained.items()):
        length = value["data_offsets"][1] - value["data_offsets"][0]
        new_header[key] = {"dtype": "BF16", "shape": value["shape"], "data_offsets": [offset, offset + length]}
        offset += length
    encoded = json.dumps(new_header, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 8)
    records = []
    with source_file.open("rb") as reader, (staging / "model.safetensors").open("xb") as writer:
        writer.write(struct.pack("<Q", len(encoded)))
        writer.write(encoded)
        for key, value in sorted(retained.items()):
            start, end = value["data_offsets"]
            reader.seek(base + start)
            remaining, digest = end - start, hashlib.sha256()
            while remaining:
                chunk = reader.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise ValueError("truncated tensor payload")
                writer.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            records.append({"name": key, "shape": value["shape"], "bytes": end-start, "sha256": digest.hexdigest()})
    output_file = staging / "model.safetensors"
    checked, output_base = read_header(output_file)
    with output_file.open("rb") as reader:
        for record in records:
            start, end = checked[record["name"]]["data_offsets"]
            reader.seek(output_base + start)
            digest, remaining = hashlib.sha256(), end-start
            while remaining:
                chunk = reader.read(min(remaining, 1024*1024))
                if not chunk:
                    raise ValueError("truncated derived tensor")
                digest.update(chunk)
                remaining -= len(chunk)
            if digest.hexdigest() != record["sha256"]:
                raise ValueError("derived tensor differs from source")
    (staging / "model.safetensors.index.json").write_text(json.dumps({"metadata": {"total_size": size},
        "weight_map": {key: "model.safetensors" for key in new_header}}, indent=2) + "\n")
    manifest = {"schemaVersion": 1, "sourceSha256": file_digest(source_file),
        "artifactSha256": file_digest(output_file), "tensorCount": len(records), "tensorBytes": size,
        "parameters": sum(math.prod(r["shape"]) for r in records), "dtype": "BF16", "tensors": records,
        "configSha256": file_digest(staging / "config.json")}
    (staging / "artifact.json").write_text(json.dumps(manifest, indent=2) + "\n")
    staging.rename(destination)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = build_text_artifact(args.root, args.source, args.output)
    print(json.dumps({k: v for k, v in result.items() if k != "tensors"}))

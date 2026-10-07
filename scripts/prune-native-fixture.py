"""Production-sized synthetic store only; never accepts an existing directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import time
import uuid


def resource_use():
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return {"peakRssBytes": int(usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)),
            "cpuUserSeconds": usage.ru_utime, "cpuSystemSeconds": usage.ru_stime}


def measure(root):
    stats = [p.stat() for p in root.rglob("*") if p.is_file()]
    space = os.statvfs(root)
    return {"fileBytes": sum(s.st_size for s in stats),
            "allocatedBytes": sum(s.st_blocks * 512 for s in stats),
            "freeBytes": space.f_bavail * space.f_frsize}


def snapshot(dataset):
    state = {"fragments": [f.metadata.to_json() for f in dataset.get_fragments()],
             "indices": dataset.list_indices(),
             "schema": dataset.schema.serialize().to_pybytes().hex()}
    return json.loads(json.dumps(state, default=lambda item: sorted(item) if isinstance(item, set) else str(item)))


def hashes(root):
    result = {}
    for path in root.rglob("*"):
        if path.is_file():
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            result[str(path.relative_to(root))] = digest
    return result


def prepare(root, rows):
    if root.exists():
        raise ValueError("Fixture refuses an existing table")
    import numpy as np
    import pyarrow as pa
    import lance
    pa.set_cpu_count(1)
    pa.set_io_thread_count(1)
    schema = pa.schema([
        ("id", pa.string()), ("path", pa.string()), ("content", pa.string()),
        ("vector", pa.list_(pa.float32(), 384)),
    ])

    def batches(prefix, start, count):
        for offset in range(start, start + count, 5000):
            n = min(5000, start + count - offset)
            dense = np.random.default_rng(offset + 17).standard_normal((n, 384), dtype=np.float32)
            yield pa.RecordBatch.from_arrays([
                pa.array([f"{prefix}-{i}" for i in range(offset, offset + n)]),
                pa.array([f"/fixture/project/{prefix}-{i}.ts" for i in range(offset, offset + n)]),
                pa.array(["retainedneedle fixture source" if prefix == "current" and i < 20000 else "unindexedtailneedle fixture source" for i in range(offset, offset + n)]),
                pa.FixedSizeListArray.from_arrays(pa.array(dense.reshape(-1)), 384),
            ], schema=schema)

    def write(prefix, start, count, mode):
        reader = pa.RecordBatchReader.from_batches(schema, batches(prefix, start, count))
        return lance.write_dataset(reader, str(root), mode=mode, max_rows_per_file=10000)

    ds = write("protected", 0, 20000, "create")
    tagged = ds.version
    ds.tags.create("protected", tagged)
    # One large retained copy simulates the physical cost of a superseded write.
    ds = write("obsolete", 0, rows, "overwrite")
    ds = write("current", 0, 20000, "overwrite")
    ds.create_scalar_index("content", "INVERTED", name="fixture_fts")
    cutoff = time.time_ns() // 1_000_000
    time.sleep(0.02)
    ds = write("current", 20000, rows - 20000, "append")
    post_cutoff = ds.version
    ds.delete("id IN ('current-0', 'current-1')")
    # Protect a fresh unverified file; the helper must not aggressively delete it.
    data_dir = next((root / name for name in ("data", "_data") if (root / name).is_dir()), None)
    assert data_dir is not None, "Native writer did not create a data directory"
    orphan = data_dir / f"{uuid.uuid4()}.lance"
    orphan.write_bytes(b"fresh unverified fixture; must survive")
    manifest = {
        "version": ds.version, "cutoffMs": cutoff, "rows": rows - 2,
        "tagged": tagged, "postCutoff": post_cutoff,
        "fragments": len(ds.get_fragments()), "hashes": hashes(root),
        "orphan": str(orphan.relative_to(root)),
        "protectedState": {str(v): snapshot(lance.dataset(str(root), version=v))
                           for v in (tagged, post_cutoff, ds.version)},
        "measurements": measure(root), "resources": resource_use(),
    }
    (root.parent / "fixture.json").write_text(json.dumps(manifest))
    print(json.dumps({k: v for k, v in manifest.items() if k not in ("hashes", "protectedState")}))


def verify(root):
    import lance
    manifest = json.loads((root.parent / "fixture.json").read_text())
    ds = lance.dataset(str(root), index_cache_size_bytes=8 * 1024**2, metadata_cache_size_bytes=8 * 1024**2)
    assert ds.version == manifest["version"] and ds.count_rows() == manifest["rows"]
    versions = {v["version"] for v in ds.versions()}
    assert {manifest["tagged"], manifest["postCutoff"], manifest["version"]}.issubset(versions)
    protected = lance.dataset(str(root), version=manifest["tagged"])
    assert protected.count_rows() == 20000
    assert protected.head(1)["id"][0].as_py() == "protected-0"
    post_cutoff = lance.dataset(str(root), version=manifest["postCutoff"])
    assert post_cutoff.count_rows() == manifest["rows"] + 2
    assert post_cutoff.head(1)["id"][0].as_py() == "current-0"
    for version, expected in manifest["protectedState"].items():
        assert snapshot(lance.dataset(str(root), version=int(version))) == expected, "Protected metadata changed"
    after = hashes(root)
    assert set(after).issubset(manifest["hashes"]), "Cleanup created files"
    assert all(manifest["hashes"][name] == digest for name, digest in after.items()), "Cleanup rewrote a retained file"
    assert manifest["orphan"] in after, "Unverified file was deleted"
    print(json.dumps({"verifiedRows": ds.count_rows(), "retainedFiles": len(after), "versions": sorted(versions),
                      "measurements": measure(root), "resources": resource_use(), "noRewrites": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "verify"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--rows", type=int, default=600000)
    args = parser.parse_args()
    assert args.root.is_absolute() and args.root.name == "chunks.lance"
    if args.mode == "prepare":
        assert 20000 <= args.rows <= 600000
        prepare(args.root, args.rows)
    else:
        verify(args.root)

"""Production-sized synthetic store only; never accepts an existing directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import time


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
    orphan = root / "_data" / "unverified-fixture.lance"
    orphan.write_bytes(b"fresh unverified fixture; must survive")
    manifest = {
        "version": ds.version, "cutoffMs": cutoff, "rows": rows - 2,
        "tagged": tagged, "postCutoff": post_cutoff,
        "fragments": len(ds.get_fragments()), "hashes": hashes(root),
        "preparePeakRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }
    (root.parent / "fixture.json").write_text(json.dumps(manifest))
    print(json.dumps({k: v for k, v in manifest.items() if k != "hashes"}))


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
    after = hashes(root)
    assert set(after).issubset(manifest["hashes"]), "Cleanup created files"
    assert all(manifest["hashes"][name] == digest for name, digest in after.items()), "Cleanup rewrote a retained file"
    assert "_data/unverified-fixture.lance" in after, "Unverified file was deleted"
    print(json.dumps({"verifiedRows": ds.count_rows(), "retainedFiles": len(after), "versions": sorted(versions), "verifyPeakRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "noRewrites": True}))


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

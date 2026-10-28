"""Explicit, exclusively leased Lance 12 FTS delta update. No compaction/pruning.

Input limits are preflight admission, not a native cumulative-write guarantee.
The parent holds exclusion through child close, monitors resources and records
uncertain completion. No automatic retry or orphan deletion is performed.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import sys
import time

INDEX = "content_idx"
MAX_ROWS = 100_000
MAX_CONTENT_BYTES = 64 * 1024**2
MAX_FRAGMENTS = 10_000
MAX_SEGMENTS = 256
MAX_FILES = 100_000
DISK_MARGIN = 1024**3
MAX_GROWTH = 512 * 1024**2


def limits():
    # Metadata/statistics APIs can otherwise migrate legacy manifests through a
    # delete(false) commit. Preflight must never silently become a writer.
    os.environ["LANCE_AUTO_MIGRATION"] = "false"
    for key in ("LANCE_CPU_THREADS", "LANCE_IO_THREADS", "RAYON_NUM_THREADS",
                "TOKIO_WORKER_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
                "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[key] = "1"
    # Native writers stall with one Lance I/O worker in this pinned release.
    # The earlier accepted FTS experiment also used two, while prune-only
    # deletion intentionally retains its separate single-worker environment.
    os.environ["LANCE_IO_THREADS"] = "2"
    resource.setrlimit(resource.RLIMIT_CPU, (90, 91))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_GROWTH, MAX_GROWTH))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        os.nice(10)
        os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])


def verify_owner(root, owner_file, nonce):
    expected = Path(str(root.parent) + ".lease") / "exclusive-intent" / "owner.json"
    if Path(owner_file) != expected or expected.is_symlink():
        raise ValueError("ownership")
    if not expected.is_file() or expected.stat().st_size > 16 * 1024:
        raise ValueError("ownership")
    owner = json.loads(expected.read_text())
    helper = owner.get("activeHelper", {})
    if (owner.get("nonce") != nonce or owner.get("pid") != os.getpid()
            or helper.get("pid") != os.getpid()
            or helper.get("processStart") in (None, "unverified")
            or owner.get("processStart") != helper.get("processStart")):
        raise ValueError("ownership")
    readers = expected.parent.parent / "readers"
    if not readers.is_dir() or any(readers.glob("*.json")):
        raise ValueError("ownership")
    return owner


def inventory(root):
    """Metadata only; refuse symlinks and stop at a fixed entry count."""
    files = {}
    pending = [root]
    count = 0
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                count += 1
                if count > MAX_FILES or entry.is_symlink():
                    raise ValueError("inventory")
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    files[str(Path(entry.path).relative_to(root))] = (
                        stat.st_size, stat.st_mtime_ns, stat.st_ino)
                else:
                    raise ValueError("inventory")
    return files


def canonical(value):
    return json.dumps(value, sort_keys=True, default=lambda x: sorted(x) if isinstance(x, set) else str(x))


def indices(ds):
    values = ds.list_indices()
    if len(values) > MAX_SEGMENTS:
        raise ValueError("segments")
    selected = [i for i in values if i["name"] == INDEX]
    if (not selected or len(selected) > MAX_SEGMENTS
            or any(i["fields"] != ["content"] or str(i["type"]).upper() not in ("INVERTED", "FTS") for i in selected)):
        raise ValueError("index")
    return values, selected


def open_dataset(lance, root):
    return lance.dataset(str(root), index_cache_size_bytes=8 * 1024**2,
                         metadata_cache_size_bytes=8 * 1024**2,
                         read_params={"cache_repetition_index": False})


def index_config(ds):
    descriptions = [d for d in ds.describe_indices() if d.name == INDEX]
    if (len(descriptions) != 1 or descriptions[0].field_names != ["content"]
            or not descriptions[0].type_url.endswith("InvertedIndexDetails")):
        raise ValueError("index")
    description = descriptions[0]
    details = description.details
    # Do not silently substitute creation defaults for legacy/unknown metadata.
    if not isinstance(details, dict) or "base_tokenizer" not in details or "with_position" not in details:
        raise ValueError("index")
    versions = [s.index_version for s in description.segments]
    if not versions or any(v not in (1, 2, 3) for v in versions):
        raise ValueError("index")
    return details, max(versions)


def prepare(ds):
    all_indices, selected = indices(ds)
    if len(selected) >= MAX_SEGMENTS:
        raise ValueError("segments")
    fragments = ds.get_fragments()
    if len(fragments) > MAX_FRAGMENTS:
        raise ValueError("fragments")
    covered = set().union(*(set(i["fragment_ids"]) for i in selected))
    pending = sorted((f for f in fragments if f.fragment_id not in covered),
                     key=lambda f: f.fragment_id)
    stats = ds.index_statistics(INDEX)
    unindexed = stats["num_unindexed_rows"]
    if type(unindexed) is not int or not 0 <= unindexed <= sum(f.physical_rows for f in pending):
        raise ValueError("coverage")
    # The public segment commit drops deferred zero-coverage placeholders.
    # This operation promises to retain old segments, so refuse that case.
    if unindexed and any(not set(i["fragment_ids"]) for i in selected):
        raise ValueError("index")
    # Admit a deterministic prefix of whole fragments. Physical admission counts
    # deleted rows too. Only this prefix's live content is read; never scan the
    # entire backlog to fit a batch, and never split a fragment's index coverage.
    import pyarrow.compute as pc
    content_bytes = live_rows = physical_rows = 0
    batch_fragments = []
    for fragment in pending:
        if physical_rows + fragment.physical_rows > MAX_ROWS:
            if not batch_fragments:
                raise ValueError("rows")
            break
        fragment_bytes = fragment_rows = 0
        for batch in fragment.to_batches(columns=["content"], batch_size=256,
                                          batch_readahead=1):
            fragment_rows += batch.num_rows
            fragment_bytes += pc.sum(pc.binary_length(batch.column(0))).as_py() or 0
            if content_bytes + fragment_bytes > MAX_CONTENT_BYTES:
                break
        if content_bytes + fragment_bytes > MAX_CONTENT_BYTES:
            if not batch_fragments or not live_rows:
                raise ValueError("content-bytes")
            break
        if fragment_rows != fragment.count_rows():
            raise ValueError("coverage")
        batch_fragments.append(fragment.fragment_id)
        physical_rows += fragment.physical_rows
        live_rows += fragment_rows
        content_bytes += fragment_bytes
    if live_rows > unindexed or (len(batch_fragments) == len(pending) and live_rows != unindexed):
        raise ValueError("coverage")
    if unindexed and not live_rows:
        raise ValueError("rows")
    if live_rows and len(all_indices) >= MAX_SEGMENTS:
        raise ValueError("segments")
    metadata = [f.metadata.to_json() for f in fragments]
    return ({"rows": ds.count_rows(), "unindexedRows": unindexed,
             "batchRows": live_rows, "selectedFragments": len(batch_fragments),
             "physicalInputRows": physical_rows, "contentBytes": content_bytes,
             "pendingFragments": len(pending), "segmentsBefore": len(selected)},
            metadata, all_indices, batch_fragments)


def append_batch(ds, fragment_ids, details, format_version, verify):
    from lance.indices import IndexConfig
    parameters = {**details, "format_version": format_version,
                  "memory_limit": 128, "num_workers": 1}
    # The build requires replace=True to reuse an existing name, but is strictly
    # uncommitted. Only the disjoint-segment commit below publishes metadata;
    # it retains every existing segment rather than replacing the logical index.
    segment = ds.create_index_uncommitted(
        "content", IndexConfig("inverted", parameters), name=INDEX,
        replace=True, fragment_ids=fragment_ids,
        document_granularity=details.get("document_granularity", "row"))
    if set(segment.fragment_ids) != set(fragment_ids):
        raise ValueError("verification-new-index")
    # Building may be interrupted without a commit. Recheck ownership/head
    # immediately before publishing; retained segments have disjoint coverage.
    verify()
    ds.commit_existing_index_segments(INDEX, "content", [segment])


def run(args, admission):
    root = Path(args.table)
    if (root.is_symlink() or not root.is_absolute() or not root.is_dir()
            or root.name != "chunks.lance" or root.resolve(strict=True) != root):
        raise ValueError("table")
    owner = verify_owner(root, args.lease_owner, args.lease_nonce)
    if importlib.metadata.version("pylance") != "12.0.0":
        raise ValueError("engine")
    before_files = inventory(root)
    import lance
    ds = open_dataset(lance, root)
    if ds.version != args.expected_version or ds.latest_version != args.expected_version:
        raise ValueError("version")
    config = ds.config()
    # A native commit can run a manifest-configured retention hook. Refuse it
    # rather than changing persistent configuration or silently pruning files.
    if any(key.startswith("lance.auto_cleanup.") for key in config):
        raise ValueError("automatic-cleanup")
    plan, fragments, before_indices, batch_fragments = prepare(ds)
    details, format_version = index_config(ds)
    schema = ds.schema.serialize().to_pybytes()
    tags = canonical(ds.tags.list())
    fingerprint = hashlib.sha256(canonical([fragments, before_indices, schema.hex(), tags]).encode()).hexdigest()
    if os.statvfs(root).f_bavail * os.statvfs(root).f_frsize < MAX_GROWTH + DISK_MARGIN:
        raise ValueError("disk")
    admission()
    if (verify_owner(root, args.lease_owner, args.lease_nonce) != owner
            or ds.latest_version != args.expected_version):
        raise ValueError("ownership-or-version")
    started = time.monotonic()
    def verify_before_commit():
        if (verify_owner(root, args.lease_owner, args.lease_nonce) != owner
                or ds.latest_version != args.expected_version):
            raise ValueError("ownership-or-version")
    if args.run and plan["batchRows"]:
        append_batch(ds, batch_fragments, details, format_version, verify_before_commit)
    after = open_dataset(lance, root)
    after_files = inventory(root)
    after_indices, after_selected = indices(after)
    old_selected = [i for i in before_indices if i["name"] == INDEX]
    changed = bool(args.run and plan["batchRows"])
    added = [i for i in after_selected if i["uuid"] not in {j["uuid"] for j in old_selected}]
    # Fresh readers must agree, including after native commit. All historical
    # files remain; only new FTS files, a transaction and manifest may be added.
    checks = {
        "head": after.version == args.expected_version + int(changed) and after.latest_version == after.version,
        "fragments": [f.metadata.to_json() for f in after.get_fragments()] == fragments,
        "schema": after.schema.serialize().to_pybytes() == schema,
        "config": after.config() == config,
        "tags": canonical(after.tags.list()) == tags,
        "rows": after.count_rows() == plan["rows"],
        # The commit may update control metadata. Immutable payloads and old
        # index files must remain identical; manifests are checked by head,
        # fragment/index metadata, config and tag invariants above/below.
        "files": all(after_files.get(name) == stat for name, stat in before_files.items()
                     if name.startswith(("data/", "_indices/", "_deletions/"))),
        "other-index": canonical([i for i in after_indices if i["name"] != INDEX]) == canonical([i for i in before_indices if i["name"] != INDEX]),
        "old-index": all(canonical(i) in {canonical(j) for j in after_selected} for i in old_selected),
        "new-index": (len(after_selected) == len(old_selected) + int(changed)
                      and (not changed or (len(added) == 1
                           and set(added[0]["fragment_ids"]) == set(batch_fragments)))
                      and index_config(after)[0] == details),
        "owner": verify_owner(root, args.lease_owner, args.lease_nonce) == owner,
    }
    for category, passed in checks.items():
        if not passed:
            raise ValueError("verification-" + category)
    remaining = after.index_statistics(INDEX)["num_unindexed_rows"]
    if remaining != plan["unindexedRows"] - (plan["batchRows"] if args.run else 0):
        raise ValueError("verification")
    growth = sum(v[0] for k, v in after_files.items() if k not in before_files)
    if growth > MAX_GROWTH:
        raise ValueError("growth")
    return {"engine": "12.0.0", "index": INDEX, "beforeVersion": args.expected_version,
            "afterVersion": after.version, "outcome": "completed" if args.run else "checked",
            "dataRewritten": False, "remainingRows": remaining, "newFileBytes": growth,
            "beforeFingerprint": fingerprint, "elapsedMs": round((time.monotonic() - started) * 1000),
            **plan}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True)
    parser.add_argument("--expected-version", required=True, type=int)
    parser.add_argument("--lease-owner", required=True)
    parser.add_argument("--lease-nonce", required=True)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    limits()
    # The parent pins this helper as the durable owner before native imports.
    print(json.dumps({"admission": "launch"}), flush=True)
    if sys.stdin.readline(256).strip() != args.lease_nonce:
        raise ValueError("admission")
    def admit():
        print(json.dumps({"admission": "ready"}), flush=True)
        if sys.stdin.readline(256).strip() != args.lease_nonce:
            raise ValueError("admission")
    print(json.dumps(run(args, admit)), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Only fixed categories cross the child boundary. Native exception text
        # can contain paths/content, so never echo it to the CLI.
        known = {"ownership", "inventory", "segments", "index", "fragments", "rows",
                 "content-bytes", "coverage", "table", "engine", "version", "disk",
                 "ownership-or-version", "verification", "growth", "admission",
                 "automatic-cleanup"}
        known.update("verification-" + key for key in ("head", "fragments", "schema",
                     "config", "tags", "rows", "files", "other-index", "old-index", "new-index", "owner"))
        message = str(error)
        category = message if isinstance(error, ValueError) and message in known else (
            "native-memory" if isinstance(error, MemoryError) or "allocate memory" in message.lower()
            else "native-files" if "too many open files" in message.lower() else "native")
        print("GMAX_FTS_FAILURE:" + category, file=sys.stderr, flush=True)
        sys.exit(1)

"""Explicit, exclusively leased Lance 12 prune-only recovery candidate.

Never compacts, writes rows, builds indexes or starts a server. This helper is
not an automatic maintenance path. Native production resource validation is
required before enabling it on a pressured host.
"""

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

MAX_FILES = 100_000
MAX_VERSIONS = 100_000
CACHE_BYTES = 8 * 1024 * 1024


def apply_resource_limits():
    # Must run before importing native libraries. Cache limits are not total
    # memory limits. RLIMIT_RSS is not enforceable on macOS; do not claim it is.
    for name in ("RAYON_NUM_THREADS", "TOKIO_WORKER_THREADS", "OMP_NUM_THREADS",
                 "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[name] = "1"
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (90, 91))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))


def verify_lease(root, owner_file, nonce):
    expected = Path(str(root.parent) + ".lease") / "exclusive-intent" / "owner.json"
    if Path(owner_file).resolve(strict=True) != expected.resolve(strict=True):
        raise ValueError("Exclusive lease belongs to a different store")
    if expected.is_symlink() or expected.stat().st_size > 16 * 1024:
        raise ValueError("Exclusive lease owner is unverified or oversized")
    owner = json.loads(expected.read_text())
    if not nonce or owner.get("nonce") != nonce or owner.get("pid") != os.getppid():
        raise ValueError("Exclusive lease ownership could not be verified")
    readers = expected.parent.parent / "readers"
    if not readers.is_dir() or any(readers.glob("*.json")):
        raise ValueError("All shared store owners must close before pruning")
    return owner


def measure(root):
    total = allocated = count = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > MAX_FILES:
                    raise ValueError("Recovery metadata scan exceeded bounded file count")
                if entry.is_symlink():
                    raise ValueError("Recovery refuses symlinks inside the table")
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    total += stat.st_size
                    allocated += stat.st_blocks * 512
                else:
                    raise ValueError("Recovery refuses nonregular table entries")
    space = os.statvfs(root)
    return total, allocated, space.f_bavail * space.f_frsize


def tag_versions(dataset):
    return {name: dataset.tags.get_version(name) for name in dataset.tags.list()}


def open_dataset(lance, root):
    return lance.dataset(
        str(root), index_cache_size_bytes=CACHE_BYTES,
        metadata_cache_size_bytes=CACHE_BYTES,
        read_params={"cache_repetition_index": False},
    )


def snapshot(dataset):
    return (
        [fragment.metadata.to_json() for fragment in dataset.get_fragments()],
        dataset.list_indices(),
        dataset.schema.serialize().to_pybytes(),
        tag_versions(dataset),
    )


def prune(store, expected_version, cutoff_ms, owner_file, nonce):
    root = Path(store).resolve(strict=True)
    if not root.is_dir() or root.suffix != ".lance":
        raise ValueError("Cleanup requires a local Lance table directory")
    owner = verify_lease(root, owner_file, nonce)
    if not isinstance(expected_version, int) or expected_version < 1:
        raise ValueError("Cleanup requires a positive current version")
    if cutoff_ms > time.time_ns() // 1_000_000:
        raise ValueError("Cleanup cutoff must not be in the future")
    if importlib.metadata.version("pylance") != "12.0.0":
        raise ValueError("Cleanup requires pylance 12.0.0")
    before_bytes, before_allocated, before_free = measure(root)
    import lance
    dataset = open_dataset(lance, root)
    if dataset.version != expected_version or dataset.latest_version != expected_version:
        raise ValueError("Table changed before cleanup")
    current = snapshot(dataset)
    all_versions = dataset.versions()
    if len(all_versions) > MAX_VERSIONS:
        raise ValueError("Recovery exceeded bounded version count")
    protected = {expected_version, *current[3].values()}
    versions = []
    for version in all_versions:
        if version["timestamp"].timestamp() * 1000 >= cutoff_ms:
            protected.add(version["version"])
        if version["version"] not in protected and version["timestamp"].timestamp() * 1000 < cutoff_ms:
            versions.append(version["version"])
    if dataset.latest_version != expected_version or verify_lease(root, owner_file, nonce) != owner:
        raise ValueError("Table or exclusive ownership changed during cleanup admission")
    # Explicit versions preserve current/tagged/post-cutoff commits. Unverified
    # files stay protected. The native operation cannot rewrite data/index files.
    stats = dataset.cleanup_old_versions(
        versions=versions, delete_unverified=False,
        error_if_tagged_old_versions=True, delete_rate_limit=32,
    ) if versions else None
    fresh = open_dataset(lance, root)
    remaining = {version["version"] for version in fresh.versions()}
    if (fresh.version != expected_version or fresh.latest_version != expected_version
            or snapshot(fresh) != current or not protected.issubset(remaining)
            or set(versions).intersection(remaining)
            or verify_lease(root, owner_file, nonce) != owner):
        raise ValueError("Current/protected state or exclusive ownership changed; no retry")
    after_bytes, after_allocated, after_free = measure(root)
    return {
        "engine": "12.0.0", "version": expected_version,
        "fragments": len(current[0]),
        "bytesRemoved": stats.bytes_removed if stats else 0,
        "versionsRemoved": stats.old_versions if stats else 0,
        "rewritten": False,
        "fileBytesBefore": before_bytes, "fileBytesAfter": after_bytes,
        "allocatedBytesBefore": before_allocated, "allocatedBytesAfter": after_allocated,
        "freeBytesBefore": before_free, "freeBytesAfter": after_free,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True)
    parser.add_argument("--version", required=True, type=int)
    parser.add_argument("--cutoff-ms", required=True, type=int)
    parser.add_argument("--lease-owner", required=True)
    parser.add_argument("--lease-nonce", required=True)
    args = parser.parse_args()
    apply_resource_limits()
    print(json.dumps(prune(args.store, args.version, args.cutoff_ms, args.lease_owner, args.lease_nonce)))


if __name__ == "__main__":
    main()

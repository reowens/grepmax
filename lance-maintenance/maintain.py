"""Read-only qualification for bounded deleted-row maintenance.

Lance 12's source quotas and per-file size option are not total-write quotas.
This helper deliberately refuses execution until the native writer can enforce
a shared, non-resetting budget across data, index, metadata and temporary writes.
It never creates receipts/tags, compacts, prunes, or starts a server.
"""

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys

ENGINE = "12.0.0"
PROTOCOL_VERSION = 1
MAX_SAFE_INTEGER = 2**53 - 1
SOURCE_BYTES = 512 * 1024**2
MAX_FRAGMENTS = 64
MAX_ROWS = 32768
MAX_TABLE_FRAGMENTS = 4096
UNQUALIFIED_REASON = (
    "Lance 12 does not expose an enforceable total-write budget covering data, "
    "index remapping, metadata and verification temporary files"
)


class UnqualifiedWriteBudget(ValueError):
    """Execution was refused before native loading or any filesystem mutation."""


def positive_integer(value, name):
    if type(value) is not int or not 1 <= value <= MAX_SAFE_INTEGER:
        raise ValueError(f"{name} must be a positive safe integer")
    return value


def request_fields(expected_version, total_write_budget_bytes, free_space_margin_bytes):
    positive_integer(expected_version, "expected version")
    positive_integer(total_write_budget_bytes, "total write budget")
    positive_integer(free_space_margin_bytes, "free-space margin")
    if total_write_budget_bytes + free_space_margin_bytes > MAX_SAFE_INTEGER:
        raise ValueError("Combined budget and margin exceed safe integer range")
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "engine": ENGINE,
        "expectedVersion": expected_version,
        "totalWriteBudgetBytes": total_write_budget_bytes,
        "freeSpaceMarginBytes": free_space_margin_bytes,
        "dataWriteBoundBytes": None,
        "indexWriteBoundBytes": None,
        "metadataWriteBoundBytes": None,
        "verificationWriteBoundBytes": None,
        "totalWriteBoundBytes": None,
        "budgetKind": "cumulative-writes",
        "nativeTotalWriteBudgetEnforced": False,
        "rewritten": False,
    }


def support_module():
    spec = importlib.util.spec_from_file_location(
        "gmax_prune_support", Path(__file__).with_name("prune.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"),
        default=lambda item: sorted(item) if isinstance(item, set) else str(item),
    )


def options(fragments, source_limit):
    return {
        "target_rows_per_fragment": 8192,
        "max_rows_per_group": 64,
        "max_bytes_per_file": 256 * 1024**2,
        "materialize_deletions": True,
        "materialize_deletions_threshold": 0.0,
        "defer_index_remap": False,
        "num_threads": 1,
        "batch_size": 64,
        "io_buffer_size": 32 * 1024**2,
        "compaction_mode": "reencode",
        "max_source_bytes": source_limit,
        "max_source_fragments": MAX_FRAGMENTS,
        "max_source_rows": MAX_ROWS,
        "excluded_fragment_ids": [f.fragment_id for f in fragments if not f.num_deletions],
    }


def plan(store, expected_version, total_write_budget_bytes, free_space_margin_bytes,
         source_limit=SOURCE_BYTES):
    """Inspect a frozen candidate, without claiming its output writes are bounded.

    Must be called only on temporary fixtures until daemon read ownership and
    budget enforcement are qualified. Never turns a guessed multiplier or a
    prior observed write size into a qualified plan.
    """
    result = request_fields(expected_version, total_write_budget_bytes, free_space_margin_bytes)
    positive_integer(source_limit, "source byte limit")
    if source_limit > SOURCE_BYTES:
        raise ValueError("Source byte limit exceeds qualification maximum")
    raw_root = Path(store)
    if raw_root.is_symlink():
        raise ValueError("Qualification refuses a symlink table")
    root = raw_root.resolve(strict=True)
    if not root.is_dir() or root.suffix != ".lance":
        raise ValueError("Qualification requires a local Lance table directory")
    if importlib.metadata.version("pylance") != ENGINE:
        raise ValueError("Qualification requires pylance 12.0.0")
    support = support_module()
    before_measure = support.measure(root)
    import lance
    from lance.optimize import Compaction
    dataset = support.open_dataset(lance, root)
    if dataset.version != expected_version or dataset.latest_version != expected_version:
        raise ValueError("Table changed before qualification")
    snapshot = support.snapshot(dataset)
    fragments = dataset.get_fragments()
    if len(fragments) > MAX_TABLE_FRAGMENTS:
        raise ValueError("Fragment count exceeds bounded qualification metadata")
    remaining_deleted_rows = sum(f.num_deletions for f in fragments)
    selected_ids = []
    source_bytes = 0
    planner_options = options(fragments, source_limit)
    if remaining_deleted_rows:
        native_plan = Compaction.plan(dataset, planner_options)
        selected = [fragment for task in native_plan.tasks for fragment in task.fragments]
        selected_ids = [fragment.id for fragment in selected]
        if len(selected_ids) > MAX_FRAGMENTS or len(selected_ids) != len(set(selected_ids)):
            raise ValueError("Native source plan exceeds fragment quota")
        for fragment in selected:
            if fragment.overlays:
                raise ValueError("Overlay writes are outside bounded qualification")
            for data_file in fragment.files:
                if data_file.base_id is not None or Path(data_file.path).name != data_file.path:
                    raise ValueError("External or unverified source file")
                file = root / "data" / data_file.path
                if file.is_symlink() or not file.is_file():
                    raise ValueError("Unverified source file")
                source_bytes += file.stat().st_size
        if source_bytes > source_limit:
            raise ValueError("Native source plan exceeds source byte quota")
    # File sizes are useful evidence, never an index-remapping output bound.
    index_file_bytes = 0
    indices = root / "_indices"
    if indices.exists():
        index_file_bytes = support.measure(indices)[0]
    if (dataset.latest_version != expected_version or support.snapshot(dataset) != snapshot
            or support.measure(root)[:2] != before_measure[:2]):
        raise ValueError("Table changed during read-only qualification")
    result.update({
        "status": "blocked" if remaining_deleted_rows else "no-work",
        "reason": UNQUALIFIED_REASON if remaining_deleted_rows else "No deleted rows",
        "selectedFragmentIds": selected_ids,
        "sourceBytes": source_bytes,
        "sourceLimitBytes": source_limit,
        "indexDirectoryFileBytes": index_file_bytes,
        "remainingDeletedRows": remaining_deleted_rows,
        "fileBytes": before_measure[0],
        "allocatedBytes": before_measure[1],
        "freeBytes": before_measure[2],
        "hasStableRowIds": dataset.has_stable_row_ids,
        "limitations": [
            "max_source_bytes limits source data/overlay files, not output writes",
            "Blob v2 payloads are excluded from the native source-byte quota",
            "max_bytes_per_file is a per-file target, not a cumulative write quota",
            "Index remapping may rewrite complete search indexes",
            "Free-space sampling and per-file resource limits cannot enforce total writes",
            "Compaction changes the head; prune-only read windows do not protect it",
        ],
    })
    if not remaining_deleted_rows:
        for key in ("dataWriteBoundBytes", "indexWriteBoundBytes", "metadataWriteBoundBytes",
                    "verificationWriteBoundBytes", "totalWriteBoundBytes"):
            result[key] = 0
    identity = {"request": result, "snapshot": snapshot, "options": planner_options}
    # Free space and allocated size can vary independently of a frozen plan.
    identity["request"] = {key: value for key, value in result.items()
                           if key not in ("freeBytes", "allocatedBytes")}
    result["planId"] = hashlib.sha256(canonical(identity).encode()).hexdigest()
    return result


def execute(plan_result, **_reserved):
    """Refuse even a caller-supplied 'qualified' plan; callers cannot bypass it."""
    raise UnqualifiedWriteBudget(UNQUALIFIED_REASON)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("plan", "execute"), required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--version", type=int, required=True)
    parser.add_argument("--total-write-budget-bytes", type=int, required=True)
    parser.add_argument("--free-space-margin-bytes", type=int, required=True)
    parser.add_argument("--plan-id")
    parser.add_argument("--lease-owner")
    parser.add_argument("--lease-nonce")
    args = parser.parse_args()
    if args.action == "execute":
        # No native imports, owner changes, tags, or receipts on this path.
        result = request_fields(args.version, args.total_write_budget_bytes, args.free_space_margin_bytes)
        result.update(status="blocked", reason=UNQUALIFIED_REASON, planId=args.plan_id)
        print(json.dumps(result), flush=True)
        return 3
    support_module().apply_resource_limits()
    result = plan(args.store, args.version, args.total_write_budget_bytes, args.free_space_margin_bytes)
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

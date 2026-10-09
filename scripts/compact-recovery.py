"""Operator-only, exclusively leased deleted-row recovery. Never embeds or prunes.

Separate fingerprint/compact/fingerprint stages retain the original version
until the operator has compared every live field. Uses the locked prune runtime.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location(
    'prune_support', Path(__file__).resolve().parent.parent / 'lance-maintenance/prune.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


def fingerprint(dataset, batch_size=64):
    """Hash logical column streams; independent of batch boundaries/null padding."""
    import numpy as np
    import pyarrow as pa
    import pyarrow.compute as pc
    channels = {}

    def update(key, data):
        channels.setdefault(key, hashlib.sha256()).update(data)

    def column(key, array):
        if pa.types.is_dictionary(array.type):
            array = array.dictionary_decode()
        update(key + ':valid', pc.is_valid(array).to_numpy(zero_copy_only=False).tobytes())
        kind = array.type
        if pa.types.is_null(kind):
            return
        if pa.types.is_list(kind) or pa.types.is_large_list(kind):
            filled = pc.fill_null(array, pa.scalar([], type=kind))
            update(key + ':length', pc.list_value_length(filled).cast(pa.int64()).to_numpy().astype('<i8').tobytes())
            column(key + ':child', pc.list_flatten(filled))
        elif pa.types.is_fixed_size_list(kind):
            # Flatten skips null parents; hidden physical child values are irrelevant.
            column(key + ':child', pc.list_flatten(array))
        elif pa.types.is_string(kind) or pa.types.is_binary(kind) or pa.types.is_large_string(kind) or pa.types.is_large_binary(kind):
            filled = pc.fill_null(array, pa.scalar('' if pa.types.is_string(kind) or pa.types.is_large_string(kind) else b'', type=kind))
            buffers = filled.buffers()
            dtype = '<i8' if pa.types.is_large_string(kind) or pa.types.is_large_binary(kind) else '<i4'
            offsets = np.frombuffer(buffers[1], dtype=dtype, count=len(filled)+1, offset=filled.offset*np.dtype(dtype).itemsize)
            update(key + ':length', np.diff(offsets).astype('<i8').tobytes())
            update(key + ':values', memoryview(buffers[2])[int(offsets[0]):int(offsets[-1])])
        elif pa.types.is_boolean(kind) or pa.types.is_integer(kind) or pa.types.is_floating(kind):
            filled = pc.fill_null(array, pa.scalar(False if pa.types.is_boolean(kind) else 0, type=kind))
            values = filled.to_numpy(zero_copy_only=False)
            update(key + ':values', values.astype(values.dtype.newbyteorder('<'), copy=False).tobytes())
        else:
            raise ValueError('Unsupported recovery fingerprint type: ' + str(kind))

    rows = 0
    for batch in dataset.scanner(batch_size=batch_size, strict_batch_size=True,
                                  batch_readahead=1, fragment_readahead=1,
                                  io_buffer_size=32*1024**2, scan_in_order=True).to_batches():
        rows += batch.num_rows
        for i, field in enumerate(batch.schema):
            column(str(i), batch.column(i))
    return {'rows': rows, 'schema': hashlib.sha256(dataset.schema.serialize().to_pybytes()).hexdigest(),
            'columns': {key: value.hexdigest() for key, value in sorted(channels.items())}}


def compact(dataset, root):
    # Only fragments containing deleted rows are rewritten. Clean fragments are
    # boundaries; the original snapshot remains usable until explicit prune.
    fragments = dataset.get_fragments()
    excluded = [f.fragment_id for f in fragments if not f.num_deletions]
    source_bytes = sum(p.stat().st_size for p in (root / 'data').iterdir() if p.is_file())
    if source_bytes > 32*1024**3:
        raise ValueError('Recovery source exceeds 32 GiB bound')
    free = os.statvfs(root)
    if free.f_bavail * free.f_frsize < 2*source_bytes + 5*1024**3:
        raise ValueError('Insufficient measured copy-and-validation disk headroom')
    from lance.optimize import Compaction
    options = dict(target_rows_per_fragment=8192, max_rows_per_group=64,
                   max_bytes_per_file=256*1024**2, materialize_deletions=True,
                   materialize_deletions_threshold=0.0, defer_index_remap=False,
                   num_threads=1, batch_size=64, io_buffer_size=32*1024**2,
                   compaction_mode='reencode', max_source_bytes=32*1024**3,
                   max_source_fragments=4096, max_source_rows=1_000_000,
                   excluded_fragment_ids=excluded)
    metrics = Compaction.execute(dataset, options)
    return {'metrics': str(metrics), 'options': options}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['fingerprint', 'compact'])
    parser.add_argument('--store', required=True)
    parser.add_argument('--version', type=int, required=True)
    parser.add_argument('--lease-owner', required=True)
    parser.add_argument('--lease-nonce', required=True)
    args = parser.parse_args()
    support.apply_resource_limits()
    root = Path(args.store).resolve(strict=True)
    owner = support.verify_lease(root, args.lease_owner, args.lease_nonce)
    print(json.dumps({'admission': 'launch'}), flush=True)
    if sys.stdin.readline(256).strip() != args.lease_nonce:
        raise ValueError('Launch admission unavailable')
    import importlib.metadata
    if importlib.metadata.version('pylance') != '12.0.0':
        raise ValueError('Requires locked pylance 12.0.0')
    import lance
    dataset = support.open_dataset(lance, root)
    if dataset.version != args.version or dataset.latest_version != args.version:
        raise ValueError('Table changed before recovery')
    tags = support.tag_versions(dataset)
    print(json.dumps({'admission': 'ready'}), flush=True)
    if sys.stdin.readline(256).strip() != args.lease_nonce:
        raise ValueError('Recovery admission unavailable')
    if args.stage == 'fingerprint':
        result = fingerprint(dataset)
    else:
        result = compact(dataset, root)
    fresh = support.open_dataset(lance, root)
    if support.tag_versions(fresh) != tags or support.verify_lease(root, args.lease_owner, args.lease_nonce) != owner:
        raise ValueError('Protected tags or ownership changed')
    if args.stage == 'fingerprint' and fresh.version != args.version:
        raise ValueError('Table changed while fingerprinting')
    result.update(version=fresh.version, indices=fresh.list_indices(), tags=tags,
                  deletedRows=sum(f.num_deletions for f in fresh.get_fragments()))
    print(json.dumps(result, default=str))


if __name__ == '__main__':
    main()

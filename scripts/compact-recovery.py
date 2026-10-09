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



def row_digests(dataset, batch_size=64):
    """Canonical full-row digests, including validity, lengths and float bits."""
    import numpy as np
    import pyarrow as pa
    import pyarrow.compute as pc
    import struct

    def primitive(array):
        kind = array.type
        filled = pc.fill_null(array, pa.scalar(False if pa.types.is_boolean(kind) else 0, type=kind))
        values = filled.to_numpy(zero_copy_only=False)
        data = values.astype(values.dtype.newbyteorder('<'), copy=False).tobytes()
        return pc.is_valid(array).to_numpy(zero_copy_only=False).tobytes(), data, values.dtype.itemsize

    def encode(array):
        if pa.types.is_dictionary(array.type):
            array = array.dictionary_decode()
        kind = array.type
        valid = pc.is_valid(array).to_numpy(zero_copy_only=False)
        if pa.types.is_boolean(kind) or pa.types.is_integer(kind) or pa.types.is_floating(kind):
            _, data, width = primitive(array)
            return [b'\x01'+data[i*width:(i+1)*width] if valid[i] else b'\x00' for i in range(len(array))]
        if pa.types.is_null(kind):
            return [b'\x00']*len(array)
        if pa.types.is_fixed_size_list(kind):
            width = kind.list_size
            children = array.values.slice(array.offset*width, len(array)*width)
            if pa.types.is_floating(children.type) or pa.types.is_integer(children.type):
                cv, data, item = primitive(children)
                return [b'\x01'+cv[i*width:(i+1)*width]+data[i*width*item:(i+1)*width*item] if valid[i] else b'\x00' for i in range(len(array))]
            encoded = encode(children)
            return [b'\x01'+b''.join(encoded[i*width:(i+1)*width]) if valid[i] else b'\x00' for i in range(len(array))]
        if pa.types.is_list(kind) or pa.types.is_large_list(kind):
            offsets = array.offsets.to_numpy(zero_copy_only=False)
            start = int(offsets[0])
            children = array.values.slice(start, int(offsets[-1])-start)
            offsets = offsets-start
            if pa.types.is_integer(children.type) or pa.types.is_floating(children.type):
                cv, data, item = primitive(children)
                return [b'\x01'+struct.pack('<Q', int(offsets[i+1]-offsets[i]))+cv[int(offsets[i]):int(offsets[i+1])]+data[int(offsets[i])*item:int(offsets[i+1])*item] if valid[i] else b'\x00' for i in range(len(array))]
            encoded = encode(children)
            return [b'\x01'+struct.pack('<Q', int(offsets[i+1]-offsets[i]))+b''.join(encoded[int(offsets[i]):int(offsets[i+1])]) if valid[i] else b'\x00' for i in range(len(array))]
        if pa.types.is_string(kind) or pa.types.is_large_string(kind) or pa.types.is_binary(kind) or pa.types.is_large_binary(kind):
            result = []
            for value in array:
                if not value.is_valid:
                    result.append(b'\x00')
                else:
                    data = value.as_py()
                    if isinstance(data, str):
                        data = data.encode('utf8')
                    result.append(b'\x01'+struct.pack('<Q', len(data))+data)
            return result
        raise ValueError('Unsupported recovery row type: '+str(kind))

    for batch in dataset.scanner(batch_size=batch_size, strict_batch_size=True,
                                  batch_readahead=1, fragment_readahead=1,
                                  io_buffer_size=32*1024**2, scan_in_order=True).to_batches():
        columns = [encode(array) for array in batch.columns]
        ids = batch.column(batch.schema.get_field_index('id')).to_pylist()
        for i, row_id in enumerate(ids):
            if row_id is None:
                raise ValueError('Stable row id is missing')
            digest = hashlib.sha256()
            for column in columns:
                digest.update(column[i])
            yield str(row_id), digest.digest()


def compare_versions(before, after, spool):
    """Exact multiset comparison by stable ID and every field, not scan order."""
    import sqlite3
    if not before.schema.equals(after.schema, check_metadata=True):
        raise ValueError('Schema changed')
    if before.count_rows() != after.count_rows():
        raise ValueError('Live row count changed')
    fd = os.open(spool, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    connection = sqlite3.connect(spool)
    try:
        connection.execute('PRAGMA cache_size=-8192')
        connection.execute('PRAGMA journal_mode=OFF')
        connection.execute('CREATE TABLE evidence (id TEXT, digest BLOB, n INTEGER, PRIMARY KEY(id,digest)) WITHOUT ROWID')
        rows = 0
        for row_id, digest in row_digests(before):
            connection.execute('INSERT INTO evidence VALUES (?,?,1) ON CONFLICT(id,digest) DO UPDATE SET n=n+1', (row_id,digest))
            rows += 1
        connection.commit()
        checked = 0
        for row_id, digest in row_digests(after):
            changed = connection.execute('UPDATE evidence SET n=n-1 WHERE id=? AND digest=? AND n>0', (row_id,digest)).rowcount
            if changed != 1:
                raise ValueError('Live row content or stable ID changed')
            checked += 1
        connection.commit()
        if checked != rows or connection.execute('SELECT COUNT(*) FROM evidence WHERE n!=0').fetchone()[0]:
            raise ValueError('Original live rows are missing')
        return {'rows': rows, 'allLiveFieldsEqual': True, 'comparison': 'stable-id/full-row multiset SHA256'}
    finally:
        connection.close()


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
    parser.add_argument('stage', choices=['fingerprint', 'compact', 'compare'])
    parser.add_argument('--store', required=True)
    parser.add_argument('--version', type=int, required=True)
    parser.add_argument('--lease-owner', required=True)
    parser.add_argument('--lease-nonce', required=True)
    parser.add_argument('--original-version', type=int)
    parser.add_argument('--spool')
    args = parser.parse_args()
    if args.stage == 'compare':
        if not args.original_version or not args.spool:
            parser.error('Comparison requires original version and a fresh private spool file')
        for name in ('RAYON_NUM_THREADS', 'TOKIO_WORKER_THREADS', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
            os.environ[name] = '1'
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (300, 301))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        if sys.platform.startswith('linux'):
            resource.setrlimit(resource.RLIMIT_AS, (2*1024**3, 2*1024**3))
    else:
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
    elif args.stage == 'compact':
        result = compact(dataset, root)
    else:
        result = compare_versions(support.open_version(lance, root, args.original_version), dataset, args.spool)
    fresh = support.open_dataset(lance, root)
    if support.tag_versions(fresh) != tags or support.verify_lease(root, args.lease_owner, args.lease_nonce) != owner:
        raise ValueError('Protected tags or ownership changed')
    if args.stage in ('fingerprint', 'compare') and fresh.version != args.version:
        raise ValueError('Table changed while fingerprinting')
    result.update(version=fresh.version, indices=fresh.list_indices(), tags=tags,
                  deletedRows=sum(f.num_deletions for f in fresh.get_fragments()))
    print(json.dumps(result, default=str))


if __name__ == '__main__':
    main()

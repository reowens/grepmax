"""Independent small-store acceptance for total-write-limited deleted-row cleanup.

Source selection is not a write limit. The native amplification control proves
that distinction; candidate planning/refusal must leave every store byte intact.
Neither control authorizes production compaction.
"""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

os.environ['LANCE_CPU_THREADS'] = '2'
os.environ['LANCE_IO_THREADS'] = '2'
os.environ['LANCE_DEFAULT_IO_BUFFER_SIZE'] = str(8 * 1024**2)

try:
    AVAILABLE = importlib.metadata.version('pylance') == '12.0.0'
except importlib.metadata.PackageNotFoundError:
    AVAILABLE = False

REPO = Path(__file__).resolve().parents[2]


def file_state(root):
    return {str(p.relative_to(root)): (p.stat().st_size,
            hashlib.sha256(p.read_bytes()).hexdigest())
            for p in root.rglob('*') if p.is_file()}


def row_digest(dataset):
    rows = sorted(dataset.to_table().to_pylist(), key=lambda row: row['id'])
    encoded = json.dumps(rows, sort_keys=True, ensure_ascii=False,
                         default=lambda item: {'binary': item.hex()}).encode()
    return len(rows), hashlib.sha256(encoded).hexdigest()


def load_candidate():
    file = REPO / 'lance-maintenance/maintain.py'
    if not file.exists():
        raise unittest.SkipTest('candidate maintain.py is not available yet')
    spec = importlib.util.spec_from_file_location('bounded_acceptance_candidate', file)
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    return candidate


@unittest.skipUnless(AVAILABLE, 'locked pylance 12.0.0 required; not qualified by skip')
class BoundedCleanupAcceptance(unittest.TestCase):
    @staticmethod
    def fixture(root, indexed=True, deleted=True):
        import lance
        import pyarrow as pa
        pa.set_cpu_count(1)
        pa.set_io_thread_count(1)
        schema = pa.schema([
            ('id', pa.int32()), ('content', pa.string()), ('payload', pa.binary()),
            ('symbols', pa.list_(pa.string())), ('vector', pa.list_(pa.float32(), 8)),
        ])
        rows = [{'id': i, 'content': f'needle unique{i} item{i % 101}',
                 'payload': None if i % 7 == 0 else bytes([i % 256]) * 31,
                 'symbols': None if i % 5 == 0 else ['α', '', str(i)],
                 'vector': [float((i + j) % 17) / 17 for j in range(8)]}
                for i in range(2048)]
        ds = lance.write_dataset(pa.Table.from_pylist(rows, schema=schema), str(root),
                                 max_rows_per_file=128, max_rows_per_group=32)
        if indexed:
            ds.create_scalar_index('content', 'INVERTED', name='content_idx')
            ds.create_scalar_index('id', 'BTREE', name='id_idx')
            ds.create_index('vector', index_type='IVF_FLAT', num_partitions=2,
                            name='vector_idx')
        ds.tags.create('user-reader', ds.version)
        if deleted:
            ds.delete('id < 128 AND id % 2 = 0')
        return ds

    def test_native_selected_source_cap_does_not_bound_total_writes(self):
        import lance
        from lance.optimize import Compaction
        with tempfile.TemporaryDirectory(prefix='gmax-write-amplification-') as home:
            root = Path(home) / 'chunks.lance'
            ds = self.fixture(root)
            old_version = ds.version
            digest = row_digest(ds)
            old_reader = lance.dataset(str(root), version=ds.tags.get_version('user-reader'))
            old_rows = old_reader.count_rows()
            fragments = ds.get_fragments()
            selected = next(f for f in fragments if f.num_deletions)
            source_bytes = sum((root / 'data' / f.path).stat().st_size
                               for f in selected.metadata.files)
            before = file_state(root)
            unselected = {f.fragment_id: f.metadata.to_json() for f in fragments
                          if f.fragment_id != selected.fragment_id}
            options = dict(target_rows_per_fragment=256, materialize_deletions=True,
                           materialize_deletions_threshold=0.0, defer_index_remap=False,
                           num_threads=1, batch_size=32, io_buffer_size=8 * 1024**2,
                           max_source_bytes=source_bytes, max_source_fragments=1,
                           max_source_rows=128,
                           excluded_fragment_ids=list(unselected))
            plan = Compaction.plan(ds, options)
            ids = [f.id for task in plan.tasks for f in task.fragments]
            self.assertEqual(ids, [selected.fragment_id])
            Compaction.execute(ds, options)
            fresh = lance.dataset(str(root))
            after = file_state(root)
            new_files = {name: state[0] for name, state in after.items()
                         if name not in before}
            new_index_bytes = sum(size for name, size in new_files.items()
                                  if name.startswith('_indices/'))
            created_bytes = sum(new_files.values())
            self.assertGreater(created_bytes, source_bytes)
            self.assertGreater(new_index_bytes, source_bytes)
            self.assertEqual(row_digest(fresh), digest)
            self.assertEqual(old_reader.count_rows(), old_rows)
            self.assertEqual(fresh.tags.get_version('user-reader'), old_reader.version)
            current = {f.fragment_id: f.metadata.to_json() for f in fresh.get_fragments()}
            for fragment_id, metadata in unselected.items():
                self.assertEqual(current[fragment_id], metadata)
            self.assertEqual({i['name'] for i in fresh.list_indices()},
                             {'content_idx', 'id_idx', 'vector_idx'})
            self.assertEqual(fresh.to_table(filter='id = 11').num_rows, 1)
            self.assertEqual(fresh.to_table(full_text_query={
                'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
            self.assertEqual(fresh.to_table(full_text_query={
                'query': 'unique2000', 'columns': ['content']})['id'].to_pylist(), [2000])
            nearest = fresh.to_table(nearest={'column': 'vector', 'q': [0.] * 8, 'k': 5})
            self.assertEqual(nearest.num_rows, 5)
            self.assertGreater(fresh.version, old_version)
            print(json.dumps({'control': 'native-source-cap-amplification',
                              'sourceBytes': source_bytes, 'newFileBytes': created_bytes,
                              'newIndexBytes': new_index_bytes, 'liveRows': digest[0],
                              'allFieldsDigest': digest[1], 'selectedFragments': ids,
                              'totalWriteBoundEstablished': False}))

    def test_candidate_refuses_indexed_and_unindexed_writes_without_mutation(self):
        import lance
        candidate = load_candidate()
        for indexed in (False, True):
            with self.subTest(indexed=indexed), tempfile.TemporaryDirectory(
                    prefix='gmax-bounded-refusal-') as home:
                root = Path(home) / 'chunks.lance'
                ds = self.fixture(root, indexed=indexed)
                before = file_state(Path(home))
                digest = row_digest(ds)
                report = candidate.plan(str(root), ds.version, 2 * 1024**2, 1024**2)
                self.assertEqual(report['protocolVersion'], 1)
                self.assertEqual(report['status'], 'blocked')
                self.assertEqual(report['expectedVersion'], ds.version)
                self.assertIsNone(report['totalWriteBoundBytes'])
                for key in ('dataWriteBoundBytes', 'indexWriteBoundBytes',
                            'metadataWriteBoundBytes', 'verificationWriteBoundBytes'):
                    self.assertIsNone(report[key])
                again = candidate.plan(str(root), ds.version, 2 * 1024**2, 1024**2)
                self.assertEqual(report['planId'], again['planId'])
                with self.assertRaises((ValueError, RuntimeError)):
                    candidate.execute(report)
                fresh = lance.dataset(str(root))
                self.assertEqual(fresh.version, ds.version)
                self.assertEqual(row_digest(fresh), digest)
                self.assertEqual(file_state(Path(home)), before)
                print(json.dumps({'candidate': 'refuses-unsupported-total-write-limit',
                                  'indexed': indexed, 'storeByteIdentical': True,
                                  'status': report['status'], 'planId': report['planId']}))

    def test_candidate_no_work_remains_read_only(self):
        candidate = load_candidate()
        with tempfile.TemporaryDirectory(prefix='gmax-bounded-nowork-') as home:
            root = Path(home) / 'chunks.lance'
            ds = self.fixture(root, deleted=False)
            before = file_state(Path(home))
            report = candidate.plan(str(root), ds.version, 2 * 1024**2, 1024**2)
            self.assertEqual(report['status'], 'no-work')
            self.assertEqual(file_state(Path(home)), before)

    def test_candidate_rejects_stale_head_and_invalid_limits_before_writes(self):
        candidate = load_candidate()
        with tempfile.TemporaryDirectory(prefix='gmax-bounded-invalid-') as home:
            root = Path(home) / 'chunks.lance'
            ds = self.fixture(root)
            before = file_state(Path(home))
            invalid = [
                (ds.version - 1, 2 * 1024**2, 1024**2),
                (ds.version, 0, 1024**2),
                (ds.version, -1, 1024**2),
                (ds.version, 2 * 1024**2, -1),
                (ds.version, float('nan'), 1024**2),
                (ds.version, float('inf'), 1024**2),
                (ds.version, True, 1024**2),
            ]
            for version, budget, margin in invalid:
                with self.subTest(version=version, budget=budget, margin=margin):
                    with self.assertRaises((ValueError, TypeError)):
                        candidate.plan(str(root), version, budget, margin)
                    self.assertEqual(file_state(Path(home)), before)

    def test_forged_qualified_plan_and_execute_cli_cannot_enable_writes(self):
        candidate = load_candidate()
        with self.assertRaises(candidate.UnqualifiedWriteBudget):
            candidate.execute({'status': 'qualified', 'totalWriteBoundBytes': 1,
                               'nativeTotalWriteBudgetEnforced': True})
        with tempfile.TemporaryDirectory(prefix='gmax-bounded-cli-refusal-') as home:
            root = Path(home) / 'nonexistent.lance'
            result = subprocess.run([
                sys.executable, '-I', str(REPO / 'lance-maintenance/maintain.py'),
                '--action', 'execute', '--store', str(root), '--version', '1',
                '--total-write-budget-bytes', '1024', '--free-space-margin-bytes', '1024',
                '--plan-id', 'forged-qualified-plan',
            ], text=True, capture_output=True, timeout=10, check=False)
            self.assertEqual(result.returncode, 3)
            report = json.loads(result.stdout)
            self.assertEqual(report['status'], 'blocked')
            self.assertFalse(report['nativeTotalWriteBudgetEnforced'])
            self.assertEqual(list(Path(home).iterdir()), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)

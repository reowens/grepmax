"""Tiny native retention acceptance; no production store or model is opened."""
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

os.environ['LANCE_CPU_THREADS'] = '2'
os.environ['LANCE_IO_THREADS'] = '2'
try:
    available = importlib.metadata.version('pylance') == '12.0.0'
except importlib.metadata.PackageNotFoundError:
    available = False


@unittest.skipUnless(available, 'locked pylance 12.0.0 is required')
class VersionCleanupNativeTests(unittest.TestCase):
    def test_bounded_passes_preserve_rows_indices_tags_and_unselected_versions(self):
        spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[2] / 'lance-maintenance/prune.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        helper.apply_resource_limits()
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-retention-native-') as home:
            store = Path(home) / 'store'
            root = store / 'chunks.lance'
            store.mkdir()
            rows = pa.table({'id': list(range(32)), 'content': ['retainedneedle'] * 32, 'payload': [b'\x00\xff'] * 32})
            ds = lance.write_dataset(rows, str(root), max_rows_per_file=8)
            ds.create_scalar_index('content', 'INVERTED', name='content_idx')
            ds.create_scalar_index('id', 'BTREE', name='id_idx')
            ds.tags.create('reader-snapshot', ds.version)
            tagged = ds.version
            for _ in range(7):
                ds = lance.write_dataset(rows, str(root), mode='append', max_rows_per_file=8)
            expected = ds.to_table()
            latest = ds.version
            indices = helper.snapshot(ds)[1]
            owner_file = Path(str(store) + '.lease') / 'exclusive-intent' / 'owner.json'
            owner_file.parent.mkdir(parents=True)
            readers = owner_file.parent.parent / 'readers'
            readers.mkdir()
            owner_file.write_text(json.dumps({'pid': os.getppid(), 'nonce': 'fixture'}))
            reader = readers / 'active.json'
            reader.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'shared store owners'):
                helper.prune(str(root), latest, time.time_ns() // 1_000_000, str(owner_file), 'fixture', max_versions=2)
            reader.unlink()
            before = {v['version'] for v in ds.versions()}
            result = helper.prune(str(root), latest, time.time_ns() // 1_000_000, str(owner_file), 'fixture', max_versions=2)
            self.assertEqual(result['versionsRemoved'], 2)
            self.assertGreater(result['eligibleVersionsRemaining'], 0)
            fresh = helper.open_dataset(lance, root)
            self.assertEqual(len(fresh.versions()), len(before) - 2)
            while result['eligibleVersionsRemaining']:
                result = helper.prune(str(root), latest, time.time_ns() // 1_000_000, str(owner_file), 'fixture', max_versions=2)
                self.assertLessEqual(result['versionsRemoved'], 2)
                self.assertFalse(result['rewritten'])
            fresh = helper.open_dataset(lance, root)
            self.assertEqual({v['version'] for v in fresh.versions()}, {tagged, latest})
            self.assertTrue(expected.equals(fresh.to_table()))
            self.assertEqual(helper.snapshot(fresh)[1], indices)
            self.assertEqual(helper.open_version(lance, root, tagged).count_rows(), 32)
            self.assertEqual(fresh.to_table(filter='id = 11').num_rows, 8)
            self.assertGreater(fresh.to_table(full_text_query={'query': 'retainedneedle', 'columns': ['content']}).num_rows, 0)
            again = helper.prune(str(root), latest, time.time_ns() // 1_000_000, str(owner_file), 'fixture', max_versions=2)
            self.assertEqual(again['versionsRemoved'], 0)


if __name__ == '__main__':
    unittest.main()

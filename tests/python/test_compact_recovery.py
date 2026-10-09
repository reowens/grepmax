"""Small, model-free native compaction acceptance; skips without locked pylance."""
import importlib.metadata
import importlib.util
from pathlib import Path
import tempfile
import unittest

try:
    native_available = importlib.metadata.version('pylance') == '12.0.0'
except importlib.metadata.PackageNotFoundError:
    native_available = False


@unittest.skipUnless(native_available, 'locked pylance 12.0.0 is required')
class CompactRecoveryTests(unittest.TestCase):
    def test_all_fields_indices_tags_and_batch_boundaries_survive(self):
        spec = importlib.util.spec_from_file_location('compact_recovery', Path(__file__).parents[2] / 'scripts/compact-recovery.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.support.apply_resource_limits()
        import lance
        import pyarrow as pa
        schema = pa.schema([
            ('id', pa.int32()), ('content', pa.string()), ('payload', pa.binary()),
            ('symbols', pa.list_(pa.string())), ('tokens', pa.list_(pa.int32())),
            ('vector', pa.list_(pa.float32(), 4)), ('enabled', pa.bool_()),
            ('score', pa.float64())])
        rows = [{'id': i, 'content': 'retainedneedle α' if i%3 else None,
                 'payload': bytes([i%256])*17 if i%5 else None,
                 'symbols': ['one','β',''] if i%7 else None,
                 'tokens': [] if i%4 else [i, i+1],
                 'vector': [float(i), -0.0, 1.25, -2.5] if i%9 else None,
                 'enabled': bool(i%2) if i%3 else None,
                 'score': float(i)/7 if i%4 else None} for i in range(512)]
        with tempfile.TemporaryDirectory(prefix='gmax-compact-acceptance-') as home:
            root = Path(home)/'chunks.lance'
            ds = lance.write_dataset(pa.Table.from_pylist(rows, schema=schema), str(root), max_rows_per_file=128)
            ds.create_scalar_index('content', 'INVERTED', name='content_idx')
            ds.create_scalar_index('id', 'BTREE', name='id_idx')
            ds.tags.create('original', ds.version)
            tagged = ds.tags.get_version('original')
            ds.delete('id % 2 = 0')
            version = ds.version
            expected = ds.to_table().to_pylist()
            before = module.fingerprint(ds, 7)
            self.assertEqual(before, module.fingerprint(ds, 64))
            module.compact(ds, root)
            fresh = module.support.open_dataset(lance, root)
            self.assertGreater(fresh.version, version)
            self.assertEqual(before, module.fingerprint(fresh, 13))
            self.assertEqual(expected, fresh.to_table().to_pylist())
            self.assertEqual(sum(f.num_deletions for f in fresh.get_fragments()), 0)
            self.assertEqual(fresh.tags.get_version('original'), tagged)
            self.assertEqual({x['name'] for x in fresh.list_indices()}, {'content_idx', 'id_idx'})
            self.assertEqual(fresh.to_table(filter='id = 11').num_rows, 1)
            self.assertGreater(fresh.to_table(full_text_query={'query':'retainedneedle','columns':['content']}).num_rows, 0)
            original = module.support.open_version(lance, root, tagged)
            self.assertEqual(original.count_rows(), 512)


if __name__ == '__main__':
    unittest.main()

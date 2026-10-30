"""Tiny native FTS delta compatibility; temporary stores and synthetic rows only."""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest


try:
    AVAILABLE = importlib.metadata.version("pylance") == "14.0.2"
except importlib.metadata.PackageNotFoundError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, "locked pylance 14.0.2 is required")
class FtsDeltaNativeTests(unittest.TestCase):
    def test_delta_preserves_rows_tags_files_and_other_index(self):
        spec = importlib.util.spec_from_file_location(
            "fts_delta", Path(__file__).parents[2] / "lance-maintenance/fts.py"
        )
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        helper.limits()
        import lance
        import pyarrow as pa

        with TemporaryDirectory(prefix="gmax-fts-delta-native-") as home:
            store = Path(home).resolve() / "store"
            root = store / "chunks.lance"
            store.mkdir()

            def rows(start, count):
                return pa.table({
                    "id": list(range(start, start + count)),
                    "content": [f"retainedneedle item{i}" for i in range(start, start + count)],
                    "payload": [b"\x00\xff"] * count,
                })

            ds = lance.write_dataset(rows(0, 16), str(root), max_rows_per_file=4)
            ds.create_scalar_index("content", "INVERTED", name="content_idx",
                                   with_position=True, stem=False,
                                   remove_stop_words=False, format_version=3)
            ds.create_scalar_index("id", "BTREE", name="id_idx")
            ds.tags.create("before-delta", ds.version)
            tagged = ds.version
            ds = lance.write_dataset(rows(16, 8), str(root), mode="append",
                                     max_rows_per_file=4)
            expected = ds.to_table()
            version = ds.version
            other_index = [i for i in ds.list_indices() if i["name"] == "id_idx"]
            data_hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in (root / "data").rglob("*") if p.is_file()}
            owner_file = Path(str(store) + ".lease") / "exclusive-intent/owner.json"
            owner_file.parent.mkdir(parents=True)
            (owner_file.parent.parent / "readers").mkdir()
            owner_file.write_text(json.dumps({
                "pid": os.getpid(), "nonce": "fts-native-fixture",
                "processStart": "fixture-owner",
                "activeHelper": {"pid": os.getpid(), "processStart": "fixture-owner"},
            }))
            args = SimpleNamespace(table=str(root), expected_version=version,
                                   lease_owner=str(owner_file),
                                   lease_nonce="fts-native-fixture", run=True)
            admissions = []
            result = helper.run(args, lambda: admissions.append(True))
            self.assertEqual(admissions, [True])
            self.assertEqual(result["engine"], "14.0.2")
            self.assertEqual(result["batchRows"], 8)
            self.assertEqual(result["remainingRows"], 0)
            self.assertEqual(result["afterVersion"], version + 1)
            self.assertFalse(result["dataRewritten"])
            fresh = helper.open_dataset(lance, root)
            self.assertTrue(expected.equals(fresh.to_table()))
            self.assertEqual(fresh.tags.get_version("before-delta"), tagged)
            self.assertEqual(lance.dataset(str(root), version=tagged).count_rows(), 16)
            self.assertEqual(helper.canonical(other_index), helper.canonical(
                [i for i in fresh.list_indices() if i["name"] == "id_idx"]))
            self.assertEqual(fresh.index_statistics("content_idx")["num_unindexed_rows"], 0)
            self.assertEqual(fresh.to_table(full_text_query={
                "query": "retainedneedle", "columns": ["content"]}).num_rows, 24)
            self.assertEqual(data_hashes, {
                str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (root / "data").rglob("*") if p.is_file()
            })


if __name__ == "__main__":
    unittest.main()

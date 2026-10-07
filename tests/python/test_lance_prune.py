"""Offline prune-only guards. No native engine/model/environment is loaded."""
import importlib.util
import json
import os
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "lance_prune", Path(__file__).resolve().parents[2] / "lance-maintenance" / "prune.py"
)
pruner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pruner)


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        store = Path(self.temp.name) / "store"
        self.root = store / "chunks.lance"
        self.root.mkdir(parents=True)
        lease = Path(str(store) + ".lease")
        self.owner_file = lease / "exclusive-intent" / "owner.json"
        self.owner_file.parent.mkdir(parents=True)
        (lease / "readers").mkdir()
        self.owner = {"nonce": "fixture-exclusive", "pid": os.getppid(), "processStart": "fixture"}
        self.owner_file.write_text(json.dumps(self.owner))
        self.fragment = {"id": 7, "files": [{"path": "current.lance"}], "deletion_file": {"path": "current.arrow"}}
        self.dataset = Mock()
        self.dataset.version = self.dataset.latest_version = 5
        self.dataset.get_fragments.return_value = [SimpleNamespace(metadata=SimpleNamespace(to_json=lambda: self.fragment))]
        self.dataset.list_indices.return_value = [{"uuid": "current-index", "fragment_ids": {7}}]
        self.dataset.schema.serialize.return_value.to_pybytes.return_value = b"current-schema"
        self.dataset.tags.list.return_value = {}
        self.versions = [
            {"version": 3, "timestamp": datetime.fromtimestamp(1)},
            {"version": 4, "timestamp": datetime.fromtimestamp(3)},
            {"version": 5, "timestamp": datetime.fromtimestamp(2)},
            {"version": 6, "timestamp": datetime.fromtimestamp(4)},
        ]
        self.dataset.versions.side_effect = lambda: list(self.versions)
        def cleanup(**kwargs):
            self.versions = [v for v in self.versions if v["version"] not in kwargs["versions"]]
            return SimpleNamespace(bytes_removed=100, old_versions=len(kwargs["versions"]))
        self.dataset.cleanup_old_versions.side_effect = cleanup
        self.engine = SimpleNamespace(dataset=Mock(return_value=self.dataset))
        self.addCleanup(patch.stopall)
        patch.dict("sys.modules", {"lance": self.engine}).start()
        patch.object(pruner.importlib.metadata, "version", return_value="12.0.0").start()

    def prune(self, version=5, cutoff=2500):
        return pruner.prune(str(self.root), version, cutoff, str(self.owner_file), "fixture-exclusive")

    def test_preserves_current_and_post_cutoff_versions_and_never_compacts(self):
        result = self.prune()
        self.dataset.cleanup_old_versions.assert_called_once_with(
            versions=[3], delete_unverified=False, error_if_tagged_old_versions=True, delete_rate_limit=32
        )
        self.assertEqual(result["bytesRemoved"], 100)
        self.assertFalse(result["rewritten"])
        self.assertGreaterEqual(result["allocatedBytesBefore"], 0)
        self.assertGreater(result["freeBytesAfter"], 0)
        self.dataset.optimize.assert_not_called()
        self.dataset.compact.assert_not_called()
        self.engine.dataset.assert_any_call(str(self.root.resolve()), index_cache_size_bytes=8 * 1024**2,
                                              metadata_cache_size_bytes=8 * 1024**2,
                                              read_params={"cache_repetition_index": False})

    def test_tagged_old_version_is_excluded_from_candidates(self):
        self.dataset.tags.list.return_value = {"protected": {"version": 3}}
        self.dataset.tags.get_version.return_value = 3
        result = self.prune()
        self.dataset.cleanup_old_versions.assert_not_called()
        self.assertEqual(result["bytesRemoved"], 0)

    def test_empty_selection_is_a_noop(self):
        self.versions = [{"version": 5, "timestamp": datetime.fromtimestamp(1)}]
        result = self.prune()
        self.dataset.cleanup_old_versions.assert_not_called()
        self.assertEqual(result["bytesRemoved"], 0)

    def test_wrong_or_missing_exclusive_owner_refuses_before_native_open(self):
        self.owner_file.write_text(json.dumps({**self.owner, "nonce": "other"}))
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.prune()
        self.engine.dataset.assert_not_called()

    def test_shared_unknown_owner_refuses_before_native_open(self):
        (self.owner_file.parent.parent / "readers" / "unknown.json").write_text("invalid owner")
        with self.assertRaisesRegex(ValueError, "shared store owners"):
            self.prune()
        self.engine.dataset.assert_not_called()

    def test_live_lease_belongs_to_parent_process(self):
        self.owner_file.write_text(json.dumps({**self.owner, "pid": self.owner["pid"] + 1}))
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.prune()
        self.engine.dataset.assert_not_called()

    def test_version_change_refuses_before_deletion(self):
        self.dataset.latest_version = 6
        with self.assertRaisesRegex(ValueError, "changed before"):
            self.prune()
        self.dataset.cleanup_old_versions.assert_not_called()

    def test_future_cutoff_refuses_before_open(self):
        with self.assertRaisesRegex(ValueError, "future"):
            self.prune(cutoff=10**16)
        self.engine.dataset.assert_not_called()

    def test_engine_mismatch_refuses_before_open(self):
        with patch.object(pruner.importlib.metadata, "version", return_value="13.0.0"), self.assertRaisesRegex(ValueError, "12.0.0"):
            self.prune()
        self.engine.dataset.assert_not_called()

    def test_fragment_change_after_cleanup_is_reported_without_retry(self):
        changed = Mock(wraps=self.dataset)
        changed.version = changed.latest_version = 5
        changed.versions.side_effect = lambda: list(self.versions)
        changed.get_fragments.return_value = []
        opened = iter([self.dataset, changed])
        self.engine.dataset.side_effect = lambda *args, **kwargs: self.dataset if "version" in kwargs else next(opened)
        with self.assertRaisesRegex(ValueError, "state.*changed"):
            self.prune()
        self.dataset.cleanup_old_versions.assert_called_once()

    def test_lease_loss_during_cleanup_is_reported(self):
        original = self.dataset.cleanup_old_versions.side_effect
        def cleanup(**kwargs):
            result = original(**kwargs)
            self.owner_file.write_text(json.dumps({**self.owner, "nonce": "lost"}))
            return result
        self.dataset.cleanup_old_versions.side_effect = cleanup
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.prune()
        self.dataset.cleanup_old_versions.assert_called_once()

    def test_missing_protected_version_after_cleanup_is_reported(self):
        original = self.dataset.cleanup_old_versions.side_effect
        def cleanup(**kwargs):
            result = original(**kwargs)
            self.versions = [v for v in self.versions if v["version"] != 4]
            return result
        self.dataset.cleanup_old_versions.side_effect = cleanup
        with self.assertRaisesRegex(ValueError, "protected state"):
            self.prune()

    def test_failed_deletion_is_not_reported_as_complete(self):
        self.dataset.cleanup_old_versions.side_effect = lambda **_: SimpleNamespace(bytes_removed=0, old_versions=0)
        with self.assertRaisesRegex(ValueError, "protected state"):
            self.prune()

    def test_tagged_version_error_is_not_retried(self):
        self.dataset.cleanup_old_versions.side_effect = OSError("tagged version")
        with self.assertRaisesRegex(OSError, "tagged"):
            self.prune()
        self.dataset.cleanup_old_versions.assert_called_once()

    def test_deletion_admission_failure_does_not_launch_cleanup(self):
        def refuse():
            raise ValueError("host admission changed")
        with self.assertRaisesRegex(ValueError, "admission changed"):
            pruner.prune(str(self.root), 5, 2500, str(self.owner_file), "fixture-exclusive", refuse)
        self.dataset.cleanup_old_versions.assert_not_called()

    def test_protected_metadata_bound_refuses_before_deletion(self):
        with patch.object(pruner, "MAX_PROTECTED_VERSIONS", 1), self.assertRaisesRegex(ValueError, "bounded"):
            self.prune()
        self.dataset.cleanup_old_versions.assert_not_called()

    def test_symlinks_refuse_before_native_open(self):
        (self.root / "unsafe").symlink_to(self.owner_file)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.prune()
        self.engine.dataset.assert_not_called()

    def test_project_and_lock_runtime_requirements_agree_without_uv_dev_pin(self):
        try:
            import tomllib
        except ImportError:
            self.skipTest("stdlib TOML check requires Python 3.11+")
        project = Path(__file__).resolve().parents[2] / "lance-maintenance"
        metadata = tomllib.loads((project / "pyproject.toml").read_text())
        lock = tomllib.loads((project / "uv.lock").read_text())
        entry = next(p for p in lock["package"] if p["name"] == "gmax-lance-maintenance")
        requirements = [p["name"] + p["specifier"] for p in entry["metadata"]["requires-dist"]]
        self.assertEqual(metadata["project"]["dependencies"], requirements)
        self.assertNotIn("dependency-groups", metadata)
        self.assertNotIn("dev-dependencies", entry)
        self.assertFalse(any(p["name"] == "uv" for p in lock["package"]))


if __name__ == "__main__":
    unittest.main()

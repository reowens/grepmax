"""Offline regression checks for the security gate, without Python model dependencies."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error


SPEC = importlib.util.spec_from_file_location(
    "audit_python", Path(__file__).resolve().parents[2] / "scripts" / "audit-python.py"
)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class PythonAuditTests(unittest.TestCase):
    def test_preserves_exact_registry_versions_and_reports_unscanned_sources(self):
        packages, excluded = audit.locked_packages({"package": [
            {"name": "anyio", "version": "4.12.1", "source": {"registry": "https://pypi.org/simple"}},
            {"name": "mlx-embeddings", "version": "0.0.5", "source": {"git": "https://example.test/repo#abc"}},
            {"name": "mlx-embed-server", "version": "0.1.0", "source": {"virtual": "."}},
        ]})
        self.assertEqual(packages, [{"name": "anyio", "version": "4.12.1"}])
        self.assertEqual(excluded, ["mlx-embeddings", "mlx-embed-server"])

    def test_reports_affected_packages_and_deduplicates_advisory_ids(self):
        packages = [{"name": "anyio", "version": "4.12.1"}, {"name": "safe", "version": "1"}]
        findings = audit.audit_results(packages, {"results": [
            {"vulns": [{"id": "GHSA-test"}, {"id": "GHSA-test"}]}, {},
        ]})
        self.assertEqual(findings, [{"name": "anyio", "version": "4.12.1", "advisories": ["GHSA-test"]}])

    def test_incomplete_or_malformed_responses_cannot_pass(self):
        for response in [None, [], {}, {"results": []}, {"results": [None]},
                         {"results": [{"vulns": None}]}, {"results": [{"vulns": [{}]}]}]:
            with self.subTest(response=response), self.assertRaises(ValueError):
                audit.audit_results([{"name": "anyio", "version": "4.12.1"}], response)
        with self.assertRaises(ValueError):
            audit.locked_packages({"package": []})

    def test_registry_outage_cannot_be_reported_as_a_clean_audit(self):
        with patch.object(audit.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")) as request, \
             patch.object(audit.time, "sleep"):
            with self.assertRaises(urllib.error.URLError):
                audit.query_osv([{"name": "anyio", "version": "4.12.1"}])
            self.assertEqual(request.call_count, 3)


if __name__ == "__main__":
    unittest.main()

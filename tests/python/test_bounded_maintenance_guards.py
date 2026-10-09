"""Non-native guards: forged qualification cannot reach the rewrite engine."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / "lance-maintenance" / "maintain.py"
SPEC = importlib.util.spec_from_file_location("bounded_maintenance", HELPER)
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


class BoundedMaintenanceGuardTests(unittest.TestCase):
    def test_forged_qualified_plan_cannot_load_native_or_touch_store(self):
        with patch.object(maintenance, "support_module", side_effect=AssertionError("store touched")):
            with patch.dict("sys.modules", {"lance": None}):
                with self.assertRaisesRegex(maintenance.UnqualifiedWriteBudget, "total-write budget"):
                    maintenance.execute({
                        "status": "qualified", "nativeTotalWriteBudgetEnforced": True,
                        "totalWriteBoundBytes": 1, "totalWriteBudgetBytes": 1024,
                    }, owner_file="/missing/owner.json", nonce="forged")

    def test_budget_validation_does_not_treat_boolean_or_unsafe_number_as_budget(self):
        for field in range(3):
            for invalid in (True, False, 0, -1, 1.5, "1024", 2**53):
                request = [7, 1024, 2048]
                request[field] = invalid
                with self.subTest(field=field, invalid=invalid):
                    with self.assertRaises(ValueError):
                        maintenance.request_fields(*request)
        with self.assertRaisesRegex(ValueError, "Combined budget"):
            maintenance.request_fields(7, maintenance.MAX_SAFE_INTEGER, 1)

    def test_unknown_bounds_stay_unknown_instead_of_zero_or_source_multiplier(self):
        result = maintenance.request_fields(7, 1024, 2048)
        for key in ("dataWriteBoundBytes", "indexWriteBoundBytes", "metadataWriteBoundBytes",
                    "verificationWriteBoundBytes", "totalWriteBoundBytes"):
            self.assertIsNone(result[key])
        self.assertFalse(result["nativeTotalWriteBudgetEnforced"])
        self.assertEqual(result["budgetKind"], "cumulative-writes")

    def test_cli_execution_refuses_before_even_opening_missing_store(self):
        with TemporaryDirectory(prefix="gmax-maintenance-refusal-") as home:
            missing = Path(home) / "never-created.lance"
            command = [sys.executable, "-I", str(HELPER), "--action", "execute",
                       "--store", str(missing), "--version", "7",
                       "--total-write-budget-bytes", "1024", "--free-space-margin-bytes", "2048",
                       "--plan-id", "forged", "--lease-owner", str(Path(home) / "owner.json"),
                       "--lease-nonce", "forged"]
            outcome = subprocess.run(command, capture_output=True, text=True, timeout=5)
            self.assertEqual(outcome.returncode, 3, outcome.stderr)
            result = json.loads(outcome.stdout)
            self.assertEqual(result["status"], "blocked")
            self.assertFalse(result["rewritten"])
            self.assertIsNone(result["totalWriteBoundBytes"])
            self.assertEqual(list(Path(home).iterdir()), [])


if __name__ == "__main__":
    unittest.main()

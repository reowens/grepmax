"""Fake proc contracts; source added without executing this fixture."""
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "operation_guard", Path(__file__).parents[2] / "scripts/guard-local-operation.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ProcessMetricContract(unittest.TestCase):
    def sample(self, after_state="S", after_threads=1, denied=None,
               statuses=None, verify_recovery=None, record_recovery=None):
        count = 0
        status_count = 0
        files = {}

        def opening(name, *args, **kwargs):
            if str(name).startswith("/proc/"):
                return 10
            if name == denied:
                raise PermissionError("fake inaccessible proc field")
            number = 11 + len(files)
            files[number] = name
            return number

        def reading(number):
            nonlocal count, status_count
            name = files[number]
            if name == "stat":
                values = ["0"] * 20
                values[0] = "S" if count == 0 else after_state
                values[17] = "1" if count == 0 else str(after_threads)
                values[19] = "77"
                count += 1
                return io.StringIO("123 (fake) " + " ".join(values))
            if name == "cgroup":
                return io.StringIO("0::/owned\n")
            default = "State:\tS (sleeping)\nVmSwap:\t0 kB\n"
            value = default if statuses is None else statuses[min(status_count, len(statuses)-1)]
            status_count += 1
            return io.StringIO(value)

        with patch.object(guard.os, "open", side_effect=opening), \
                patch.object(guard.os, "fdopen", side_effect=reading), \
                patch.object(guard.os, "close"):
            return guard.status(123, "/owned", lambda: True, verify_recovery, record_recovery)

    def test_live_missing_rss_fails_with_identity(self):
        with self.assertRaises(guard.ProcessMetricError) as caught:
            self.sample()
        data = caught.exception.details
        self.assertEqual(data["field"], "VmRSS")
        self.assertEqual(data["beforeIdentity"]["starttime"], 77)
        self.assertEqual(data["afterIdentity"]["state"], "S")
        self.assertEqual(data["observedCgroup"], "0::/owned")

    def test_confirmed_single_thread_dead_member_has_no_live_accounting(self):
        self.assertIsNone(self.sample(after_state="Z"))

    def test_dead_leader_with_other_threads_still_fails(self):
        with self.assertRaises(guard.ProcessMetricError):
            self.sample(after_state="Z", after_threads=2)

    def test_permission_failure_never_defaults_rss(self):
        with self.assertRaises(guard.ProcessMetricError) as caught:
            self.sample(denied="cgroup")
        self.assertIn("PermissionError", caught.exception.details["reason"])

    def test_one_fresh_complete_read_under_hard_containment(self):
        records, checks = [], []
        complete = "State:\tS (sleeping)\nVmRSS:\t12 kB\nVmSwap:\t0 kB\n"
        result = self.sample(statuses=["State:\tR (running)\n", complete],
                             verify_recovery=lambda: checks.append(True), record_recovery=records.append)
        self.assertEqual(result, {"VmRSS": 12288, "VmSwap": 0})
        self.assertEqual(len(checks), 3)
        self.assertEqual(len(records[0]["observations"]), 2)

    def test_persistent_absence_fails_after_exactly_one_reread(self):
        with self.assertRaises(guard.ProcessMetricError) as caught:
            self.sample(verify_recovery=lambda: None, record_recovery=lambda _: None)
        self.assertEqual(len(caught.exception.details["observations"]), 2)

    def test_malformed_metric_is_not_retried(self):
        checks = []
        with self.assertRaises(guard.ProcessMetricError):
            self.sample(statuses=["State:\tR (running)\nVmRSS:\tbroken\nVmSwap:\t0 kB\n"],
                        verify_recovery=lambda: checks.append(True), record_recovery=lambda _: None)
        self.assertEqual(checks, [])

    def test_expired_recovery_is_not_accepted(self):
        # Initial observation, recovery start, observation2, final time check.
        with patch.object(guard.time, "monotonic", side_effect=[1, 1.001, 1.051]):
            with self.assertRaises(guard.ProcessMetricError) as caught:
                self.sample(verify_recovery=lambda: None, record_recovery=lambda _: None)
        self.assertIn("50ms", str(caught.exception))

    def test_containment_failure_is_structured(self):
        def refused():
            raise RuntimeError("hard cap changed")
        with self.assertRaises(guard.ProcessMetricError) as caught:
            self.sample(verify_recovery=refused, record_recovery=lambda _: None)
        self.assertEqual(caught.exception.details["field"], "recovery containment")


if __name__ == "__main__":
    unittest.main()

"""Execute the release workflow's verifier with a fake registry and clock."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import urllib.error


class RegistryVerificationTests(unittest.TestCase):
    payload = b"qualified archive"
    endpoint = "https://registry.npmjs.org/grepmax/0.26.94"
    metadata = json.dumps({"version": "0.26.94", "dist": {
        "tarball": "https://registry.npmjs.org/grepmax/-/grepmax-0.26.94.tgz"
    }}).encode()

    def run_verifier(self, actions, fallback=None):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/release.yml").read_text()
        section = workflow.split("      - name: Verify registry bytes\n", 1)[1]
        code = textwrap.dedent(section.split("          python3 - <<'PY'\n", 1)[1].split("          PY\n", 1)[0])
        now = 0
        requests, sleeps = [], []

        def sleep(seconds):
            nonlocal now
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, 15)
            sleeps.append(seconds)
            now += seconds

        def urlopen(url, timeout):
            nonlocal now
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 480 - now)
            requests.append((url, timeout))
            action = actions.pop(0) if actions else fallback
            if isinstance(action, BaseException):
                if isinstance(action, TimeoutError):
                    now += timeout
                raise action
            if isinstance(action, tuple):
                now += action[0]
                action = action[1]
            self.assertIsInstance(action, bytes, "unexpected registry request")
            return io.BytesIO(action)

        with tempfile.TemporaryDirectory(prefix="gmax-registry-unit-") as home:
            summary = Path(home) / "summary.md"
            env = {"RELEASE_VERSION": "0.26.94", "ARCHIVE_SHA256": hashlib.sha256(self.payload).hexdigest(),
                   "GITHUB_RUN_ID": "fixture-run", "REVIEWED_SOURCE": "a" * 40, "GITHUB_STEP_SUMMARY": str(summary)}
            error = None
            with patch.dict(os.environ, env), patch("urllib.request.urlopen", urlopen), \
                    patch("time.monotonic", lambda: now), patch("time.monotonic_ns", lambda: int(now * 10**9)), \
                    patch("time.sleep", sleep), contextlib.redirect_stdout(io.StringIO()):
                try:
                    exec(compile(code, "release-registry-verifier", "exec"), {})
                except Exception as failure:
                    error = failure
            return error, requests, sleeps, summary.read_text() if summary.exists() else None

    def test_success_requires_matching_archive(self):
        error, requests, sleeps, summary = self.run_verifier([self.metadata, self.payload])
        self.assertIsNone(error)
        self.assertEqual(len(requests), 2)
        self.assertEqual(sleeps, [])
        self.assertIn(hashlib.sha256(self.payload).hexdigest(), summary)

    def test_metadata_read_timeout_and_wrapped_network_error_retry(self):
        error, requests, sleeps, summary = self.run_verifier([
            TimeoutError("read timed out"), urllib.error.URLError(TimeoutError("read timed out")),
            self.metadata, self.payload])
        self.assertIsNone(error)
        self.assertEqual(len(sleeps), 2)
        self.assertEqual(len(set(url for url, _ in requests[:3])), 3)
        self.assertTrue(summary)

    def test_tarball_timeout_restarts_with_fresh_metadata(self):
        error, requests, sleeps, _ = self.run_verifier([self.metadata, TimeoutError("tarball timeout"), self.metadata, self.payload])
        self.assertIsNone(error)
        self.assertEqual(len(sleeps), 1)
        self.assertNotEqual(requests[0][0], requests[2][0])

    def test_connection_reset_retries(self):
        error, _, sleeps, _ = self.run_verifier([ConnectionResetError("reset"), self.metadata, self.payload])
        self.assertIsNone(error)
        self.assertEqual(len(sleeps), 1)

    def test_only_transient_http_statuses_retry(self):
        for code in (404, 408, 429, 500, 502, 503, 504):
            with self.subTest(code=code):
                error, _, sleeps, _ = self.run_verifier([urllib.error.HTTPError(self.endpoint, code, "fixture", {}, None), self.metadata, self.payload])
                self.assertIsNone(error)
                self.assertEqual(len(sleeps), 1)
        for code in (400, 401, 403):
            with self.subTest(code=code):
                error, requests, sleeps, summary = self.run_verifier([urllib.error.HTTPError(self.endpoint, code, "fixture", {}, None)])
                self.assertIsInstance(error, urllib.error.HTTPError)
                self.assertEqual(len(requests), 1)
                self.assertEqual(sleeps, [])
                self.assertIsNone(summary)

    def test_hash_and_metadata_mismatches_never_retry_or_report_success(self):
        for actions in ([self.metadata, b"wrong bytes"], [b"{}"], [b"not JSON"],
                        [self.metadata.replace(b"0.26.94", b"0.26.93")],
                        [self.metadata.replace(b"https://registry.npmjs.org/grepmax/-/", b"https://example.invalid/")]):
            with self.subTest(actions=actions):
                error, _, sleeps, summary = self.run_verifier(list(actions))
                self.assertIsNotNone(error)
                self.assertEqual(sleeps, [])
                self.assertIsNone(summary)

    def test_deadline_caps_requests_and_stops_retries(self):
        error, requests, sleeps, summary = self.run_verifier([], fallback=TimeoutError("persistent timeout"))
        self.assertIsInstance(error, TimeoutError)
        self.assertIn("publication must not be retried", str(error))
        self.assertEqual(requests[-1][1], 20)
        self.assertEqual(sleeps[-1], 5)
        self.assertLess(len(requests), 20)
        self.assertIsNone(summary)

    def test_tarball_request_is_capped_to_remaining_deadline(self):
        error, requests, sleeps, summary = self.run_verifier([(475, self.metadata), self.payload])
        self.assertIsNone(error)
        self.assertEqual(requests[-1][1], 5)
        self.assertEqual(sleeps, [])
        self.assertTrue(summary)

    def test_deadline_between_metadata_and_tarball_refuses_download(self):
        error, requests, sleeps, summary = self.run_verifier([(480, self.metadata)])
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(len(requests), 1)
        self.assertEqual(sleeps, [])
        self.assertIsNone(summary)


if __name__ == "__main__":
    unittest.main()

"""Release artifact provenance/refusal checks; no native process or store."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    'test_real_selected_batch_preserves_rows_indices_tags_and_both_readers',
    'test_budget_exhaustion_after_data_copy_is_safe_and_never_refunded',
    'test_interruption_at_protected_and_committed_reader_windows_preserves_head',
    'test_pre_receipt_zero_payload_journal_is_safely_retired_on_admitted_attempt',
    'test_production_executable_rejects_qualification_fault_fields',
] + ['fixture_case_' + str(i) for i in range(7)]


class BoundedArtifactPackaging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gmax-artifact-provenance-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.input = self.home / 'input'
        self.output = self.home / 'accepted'
        self.digest = subprocess.check_output(
            ['node', str(ROOT / 'scripts/bounded-source-digest.cjs'),
             str(ROOT / 'lance-maintenance/native')], text=True).strip()
        for platform in ['darwin-arm64', 'linux-x64']:
            directory = self.input / ('bounded-native-' + platform)
            directory.mkdir(parents=True)
            payload = ('synthetic binary for ' + platform).encode()
            (directory / 'gmax-bounded-maintenance').write_bytes(payload)
            (directory / 'source.sha256').write_text(self.digest + '\n')
            (directory / 'build-profile.txt').write_text('release\n')
            (directory / 'THIRD-PARTY-NOTICES.txt').write_text('Fixture license text\n')
            self.write(directory / 'capabilities.json', {
                'protocolVersion': 1, 'engine': '12.0.0',
                'nativeTotalWriteBudgetEnforced': True,
                'budgetKind': 'cumulative-writes', 'protectedReaderProtocol': 1})
            proof = {'schemaVersion': 1, 'engine': '12.0.0',
                     'verdict': 'PASS_BOUNDED_NATIVE_ACCEPTANCE',
                     'binarySha256': hashlib.sha256(payload).hexdigest(),
                     'sourceDigest': self.digest, 'provenanceUnchanged': True,
                     'tests': {'executed': 12, 'passed': 12, 'skipped': 0,
                               'failures': 0, 'errors': 0},
                     'testCases': ['fixture.' + name for name in CASES]}
            self.write(directory / 'acceptance.json', proof)
            fault = dict(proof)
            fault['verdict'] = 'PASS_BOUNDED_NATIVE_FAULT_ACCEPTANCE'
            fault['tests'] = {'executed': 2, 'passed': 2, 'skipped': 0,
                              'failures': 0, 'errors': 0}
            fault['testCases'] = [
                'test_injected_backend_enospc_recovers_exact_owned_payloads_without_refund',
                'test_sigkill_after_first_owned_tag_delete_resumes_durable_finalization']
            self.write(directory / 'fault-acceptance.json', fault)

    @staticmethod
    def write(file, value):
        file.write_text(json.dumps(value))

    def assemble(self):
        return subprocess.run(['node', str(ROOT / 'scripts/assemble-bounded-runtime.cjs'),
                               str(self.input), str(self.output)],
                              text=True, capture_output=True, timeout=10)

    def test_accepted_source_and_two_platform_proofs_prepare_exact_payloads(self):
        result = self.assemble()
        self.assertEqual(result.returncode, 0, result.stderr)
        destination = self.home / 'runtime'
        prepared = subprocess.run(['node', str(ROOT / 'scripts/prepare-bounded-runtime.cjs'),
                                   str(self.output), str(destination), '--required'],
                                  text=True, capture_output=True, timeout=10)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        for platform in ['darwin-arm64', 'linux-x64']:
            binary = destination / ('gmax-bounded-maintenance-' + platform)
            self.assertEqual(binary.read_bytes(), ('synthetic binary for ' + platform).encode())
            self.assertEqual(binary.stat().st_mode & 0o777, 0o755)

    def test_changed_binary_or_source_refuses_before_creating_package(self):
        directory = self.input / 'bounded-native-linux-x64'
        (directory / 'gmax-bounded-maintenance').write_bytes(b'changed')
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())
        (directory / 'source.sha256').write_text('0' * 64)
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_skipped_fault_acceptance_or_debug_profile_cannot_be_shipped(self):
        directory = self.input / 'bounded-native-darwin-arm64'
        proof = json.loads((directory / 'fault-acceptance.json').read_text())
        proof['tests']['skipped'] = 1
        self.write(directory / 'fault-acceptance.json', proof)
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())
        proof['tests']['skipped'] = 0
        self.write(directory / 'fault-acceptance.json', proof)
        (directory / 'build-profile.txt').write_text('dev\n')
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_symlink_binary_and_absent_required_case_refuse(self):
        directory = self.input / 'bounded-native-linux-x64'
        binary = directory / 'gmax-bounded-maintenance'
        outside = self.home / 'outside'
        binary.rename(outside)
        binary.symlink_to(outside)
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())
        binary.unlink()
        outside.rename(binary)
        proof = json.loads((directory / 'acceptance.json').read_text())
        proof['testCases'][0] = 'fixture.different_case'
        self.write(directory / 'acceptance.json', proof)
        self.assertNotEqual(self.assemble().returncode, 0)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()

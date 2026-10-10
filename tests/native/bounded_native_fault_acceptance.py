"""Strict isolated-fixture faults for the qualification-only native executable.

Run separately before rebuilding the engine-only production executable. This
does not claim physical disk exhaustion; ENOSPC is injected at the metered
backend boundary after its durable charge and before the underlying write.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import time

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_core_acceptance',
        REPO / 'tests/python/test_bounded_native_acceptance.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class BoundedNativeFaultAcceptance(unittest.TestCase):
    prepare = staticmethod(core.BoundedNativeAcceptance.prepare)
    drive_to_exit = staticmethod(core.BoundedNativeAcceptance.drive_to_exit)
    failure_reason = staticmethod(core.BoundedNativeAcceptance.failure_reason)

    @classmethod
    def setUpClass(cls):
        if not core.fixture_support.AVAILABLE:
            raise RuntimeError('pinned Lance 12 runtime is required for fault qualification')
        cls.binary = os.environ.get('GMAX_BOUNDED_NATIVE_EXECUTABLE')
        if not cls.binary or not Path(cls.binary).is_file():
            raise RuntimeError('qualification-feature native executable is required')

    @staticmethod
    def payload_files(root):
        return {name: value for name, value in core.fixture_support.file_state(root).items()
                if name.startswith(('data/', '_indices/'))}

    def test_newer_orphan_and_partial_inventory_never_use_a_timestamp_cutoff(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-reference-cursor-') as home:
            root, ds = self.prepare(home, deleted=False)
            oldest = min(v['timestamp'].timestamp() for v in ds.versions())
            orphan = root / 'data' / 'newer-than-retained.lance'
            orphan.write_bytes(b'unreferenced')
            timestamp = max(time.time(), oldest) + 1
            os.utime(orphan, (timestamp, timestamp))
            self.assertGreater(orphan.stat().st_mtime, oldest)
            seed = ds.to_table(filter='id = 11').to_pylist()[0]
            for n in range(35):
                row = {**seed, 'id': 9000 + n}
                ds = lance.write_dataset(pa.Table.from_pylist([row], schema=ds.schema), str(root), mode='append')
            baseline = core.fixture_support.row_digest(ds)
            options = {'operation': 'repair-orphans', 'qualificationTimeSeconds': int(timestamp + 180)}
            session = core.NativeSession(self.binary, root, qualification=options)
            try:
                result = session.reach('result')
                self.assertFalse(result['inventoryComplete'])
                self.assertEqual(result['orphansReclaimed'], 0)
                self.assertTrue(orphan.exists(), 'partial inventory cannot authorize deletion')
            finally:
                session.close()
            session = core.NativeSession(self.binary, root, qualification=options)
            try:
                result = session.reach('result')
                self.assertTrue(result['inventoryComplete'])
                self.assertGreater(result['orphansReclaimed'], 0)
                self.assertFalse(orphan.exists())
            finally:
                session.close()
            self.assertEqual(core.fixture_support.row_digest(lance.dataset(str(root))), baseline)

    def test_relocation_interruptions_preserve_each_valid_intermediate_head(self):
        import lance
        for phase in ('after-relocation-stage', 'after-data-commit', 'after-path-commit', 'after-content-commit'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix='gmax-native-relocation-fault-') as home:
                root, ds = self.prepare(home)
                baseline = core.fixture_support.row_digest(ds)
                session = core.NativeSession(self.binary, root, qualification={
                    'operation': 'repair-relocate', 'qualificationPauseAt': phase})
                try:
                    event = session.reach('qualification-' + phase)
                    receipt = json.loads((root / '_gmax-bounded-receipt.json').read_text())
                    session.close()
                    session = core.NativeSession(self.binary, root, action='recover')
                    result = session.reach('result')
                    self.assertFalse(result['recoveryPending'])
                    self.assertLessEqual(result['sourceBytesRead'], 32 * 1024**2)
                    self.assertLessEqual(result['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                    self.assertEqual(result['receiptId'], receipt['receiptId'])
                finally:
                    session.close()
                self.assertEqual(core.fixture_support.row_digest(lance.dataset(str(root))), baseline)
                self.assertEqual(lance.dataset(str(root)).to_table(full_text_query={'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])

    def test_injected_backend_enospc_recovers_exact_owned_payloads_without_refund(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-fault-enospc-') as home:
            root, ds = self.prepare(home)
            digest = core.fixture_support.row_digest(ds)
            original_fragments = {f.fragment_id: f.metadata.to_json() for f in ds.get_fragments()}
            original_indices = ds.list_indices()
            original_schema = ds.schema
            ds = None
            original_payloads = self.payload_files(root)
            session = core.NativeSession(self.binary, root, qualification={
                'qualificationFailPathPrefix': '_indices/'})
            try:
                outcome = self.drive_to_exit(session)
                self.assertNotEqual(session.process.returncode, 0)
                self.assertIn('gmax-qualification-injected-enospc', self.failure_reason(session).lower())
                self.assertGreater(outcome['dataBytesWritten'], 0)
                self.assertGreater(outcome['indexBytesWritten'], 0)
                self.assertLessEqual(outcome['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                current = lance.dataset(str(root))
                self.assertEqual(current.schema, original_schema)
                self.assertEqual(current.list_indices(), original_indices)
                self.assertEqual({f.fragment_id: f.metadata.to_json() for f in current.get_fragments()},
                                 original_fragments)
                self.assertEqual(core.fixture_support.row_digest(current), digest)
                failed_payloads = self.payload_files(root)
                appended = current.to_table(filter='id = 11').to_pylist()[0]
                appended.update(id=4096, content='postfailurewatcher unique4096',
                                path='/fixture/post-failure-edit.ts')
                current = lance.write_dataset(pa.Table.from_pylist([appended], schema=current.schema),
                                              str(root), mode='append', max_rows_per_file=128)
                current.delete('id = 13')
                digest = core.fixture_support.row_digest(current)
                edited_version = current.version
                after_edits = self.payload_files(root)
                expected_payloads = {**original_payloads,
                                     **{name: value for name, value in after_edits.items()
                                        if name not in failed_payloads}}
                current = None
                recovery = core.NativeSession(self.binary, root, action='recover')
                try:
                    restored = self.drive_to_exit(recovery)
                    self.assertEqual(recovery.process.returncode, 0, self.failure_reason(recovery))
                    self.assertTrue(restored['aborted'])
                    self.assertFalse(restored['recoveryPending'])
                    self.assertEqual(restored['rowsVerified'], 0)
                    self.assertEqual(restored['afterVersion'], edited_version)
                    self.assertEqual(restored['dataBytesWritten'], outcome['dataBytesWritten'])
                    self.assertEqual(restored['indexBytesWritten'], outcome['indexBytesWritten'])
                    self.assertGreaterEqual(restored['totalBytesWritten'], outcome['totalBytesWritten'])
                    self.assertLessEqual(restored['totalBytesWritten'], recovery.request['totalWriteBudgetBytes'])
                    self.assertEqual(self.payload_files(root), expected_payloads)
                    current = lance.dataset(str(root))
                    self.assertEqual(core.fixture_support.row_digest(current), digest)
                    self.assertEqual(set(current.tags.list()), {'user-reader'})
                    current = None
                finally:
                    recovery.close()
                # A new attempt may compact after the previous exact objects
                # were reclaimed. Old custom attempt files cannot accumulate.
                fresh = core.NativeSession(self.binary, root)
                try:
                    completed = self.drive_to_exit(fresh)
                    self.assertEqual(fresh.process.returncode, 0, self.failure_reason(fresh))
                    self.assertEqual(completed['status'], 'committed')
                    self.assertEqual(core.fixture_support.row_digest(lance.dataset(str(root))), digest)
                    self.assertEqual(len(list(root.glob('_gmax-maintenance-*.journal'))), 1)
                    self.assertEqual(len(list(root.glob('_gmax-owned-*.jsonl'))), 1)
                finally:
                    fresh.close()
                print(json.dumps({'nativeFaultAcceptance': 'injected-backend-ENOSPC',
                                  'physicalENOSPC': False, 'outcome': outcome,
                                  'abortRecovery': restored, 'nextCommittedAttempt': completed,
                                  'watchedEditsBeforeRecovery': True, 'editedHead': edited_version,
                                  'exactOwnedPayloadsReclaimed': True}))
            finally:
                session.close()

    def test_sigkill_after_first_owned_tag_delete_resumes_durable_finalization(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-fault-tag-gap-') as home:
            root, ds = self.prepare(home)
            digest = core.fixture_support.row_digest(ds)
            ds = None
            session = core.NativeSession(self.binary, root, qualification={
                'qualificationPauseAfterFirstTagDelete': True})
            try:
                paused = session.reach('qualification-after-first-tag-delete')
                session.process.kill()
                session.process.communicate(timeout=5)
                receipt = json.loads((root / '_gmax-bounded-receipt.json').read_text())
                self.assertEqual(receipt['phase'], 'finalizing')
                self.assertTrue(receipt['acceptedFingerprint'])
                current = lance.dataset(str(root))
                committed_head = current.version
                self.assertEqual(core.fixture_support.row_digest(current), digest)
                owned_tags = set(current.tags.list()) - {'user-reader'}
                self.assertEqual(len(owned_tags), 1)
                # Normal watched edits can advance the head after the first
                # tag was released. Recovery must finalize the accepted copy
                # while preserving this newer application state.
                appended = current.to_table(filter='id = 11').to_pylist()[0]
                appended.update(id=4096, content='ordinarywatcher unique4096',
                                path='/fixture/new-watch-edit.ts')
                current = lance.write_dataset(pa.Table.from_pylist([appended], schema=current.schema),
                                              str(root), mode='append', max_rows_per_file=128)
                current.delete('id = 13')
                edited_digest = core.fixture_support.row_digest(current)
                edited_head = current.version
                self.assertGreater(edited_head, committed_head)
                current = None
                journal = next(root.glob('_gmax-maintenance-*.journal'))
                original_counts = struct.unpack('<6Q', journal.read_bytes()[-80:-32])
                original_payloads = self.payload_files(root)
                recovery = core.NativeSession(self.binary, root, action='recover')
                try:
                    recovered = self.drive_to_exit(recovery)
                    self.assertEqual(recovery.process.returncode, 0, self.failure_reason(recovery))
                    self.assertEqual(recovered['status'], 'recovered')
                    self.assertFalse(recovered['aborted'])
                    self.assertFalse(recovered['recoveryPending'])
                    self.assertTrue(recovered['acceptedFinalization'])
                    self.assertEqual(recovered['verifiedCopyVersion'], committed_head)
                    self.assertEqual(recovered['afterVersion'], edited_head)
                    self.assertEqual(recovered['rowsVerified'], 64)
                    self.assertEqual(recovered['dataBytesWritten'], original_counts[2])
                    self.assertEqual(recovered['indexBytesWritten'], original_counts[3])
                    self.assertGreaterEqual(recovered['totalBytesWritten'], original_counts[1])
                    self.assertLessEqual(recovered['totalBytesWritten'], recovery.request['totalWriteBudgetBytes'])
                    self.assertEqual(self.payload_files(root), original_payloads)
                    current = lance.dataset(str(root))
                    self.assertEqual(current.version, edited_head)
                    self.assertEqual(core.fixture_support.row_digest(current), edited_digest)
                    self.assertEqual(set(current.tags.list()), {'user-reader'})
                    self.assertEqual(current.to_table(full_text_query={
                        'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                    self.assertEqual(current.to_table(full_text_query={
                        'query': 'unique4096', 'columns': ['content']})['id'].to_pylist(), [4096])
                finally:
                    recovery.close()
                print(json.dumps({'nativeFaultAcceptance': 'partial-tag-finalization',
                                  'paused': paused, 'recovered': recovered,
                                  'editedHead': edited_head, 'allEditedFieldsDigest': edited_digest[1],
                                  'noFurtherDataOrIndexWrites': True}))
            finally:
                session.close()


def binary_digest(binary):
    if not binary or not Path(binary).is_file():
        return None
    digest = hashlib.sha256()
    with open(binary, 'rb') as handle:
        for block in iter(lambda: handle.read(1024**2), b''):
            digest.update(block)
    return digest.hexdigest()


def source_digest():
    root = REPO / 'lance-maintenance/native'
    files = [root / 'Cargo.toml', root / 'Cargo.lock', *root.joinpath('src').rglob('*.rs')]
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda file: file.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        payload = path.read_bytes()
        digest.update(f'{len(relative.encode())}:{relative}:{len(payload)}:'.encode())
        digest.update(payload)
    return digest.hexdigest()


if __name__ == '__main__':
    class TrackingResult(unittest.TextTestResult):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.executed_cases = []

        def startTest(self, test):
            self.executed_cases.append(test._testMethodName)
            super().startTest(test)

    binary = os.environ.get('GMAX_BOUNDED_NATIVE_EXECUTABLE')
    binary_sha256, source = binary_digest(binary), source_digest()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BoundedNativeFaultAcceptance)
    result = unittest.TextTestRunner(verbosity=2, resultclass=TrackingResult).run(suite)
    unchanged = (binary_sha256 is not None and binary_digest(binary) == binary_sha256
                 and source_digest() == source)
    passed = result.wasSuccessful() and result.testsRun == 4 and not result.skipped and unchanged
    evidence = {'schemaVersion': 1,
                'verdict': 'PASS_BOUNDED_NATIVE_FAULT_ACCEPTANCE' if passed else 'FAIL_BOUNDED_NATIVE_FAULT_ACCEPTANCE',
                'binarySha256': binary_sha256, 'sourceDigest': source,
                'provenanceUnchanged': unchanged, 'qualificationFeature': True,
                'engine': '12.0.0', 'testCases': result.executed_cases,
                'tests': {'executed': result.testsRun,
                          'passed': max(0, result.testsRun - len(result.errors) - len(result.failures) - len(result.skipped)),
                          'skipped': len(result.skipped), 'failures': len(result.failures), 'errors': len(result.errors)},
                'physicalENOSPC': False,
                'scope': ['durably charged injected index-write ENOSPC before backend mutation',
                          'unchanged failure head; later watched edits preserved during owned orphan reclamation',
                          'durable proven-abort recovery keeps original charged bytes without refund',
                          'next attempt admission and bounded custom journal/log retention',
                          'SIGKILL after first owned-tag deletion; same-ledger finalization recovery'],
                'limits': ['qualification binary is not a production artifact',
                           'does not establish physical ENOSPC behavior',
                           'no production store/process touched']}
    if os.environ.get('GMAX_BOUNDED_FAULT_EVIDENCE'):
        Path(os.environ['GMAX_BOUNDED_FAULT_EVIDENCE']).write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))
    raise SystemExit(0 if passed else 1)

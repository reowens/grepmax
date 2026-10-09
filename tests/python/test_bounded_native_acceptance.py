"""Independent actual-mutation acceptance for the metered Lance 12 executable.

GMAX_BOUNDED_NATIVE_EXECUTABLE must name the candidate executable. Ordinary
discovery skips unavailable native dependencies; this standalone runner fails
qualification on any skipped test. Every store and owner marker is private
to a small temporary fixture; no production process or store is accessed.
"""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import struct
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('bounded_fixture',
        Path(__file__).with_name('test_bounded_cleanup_acceptance.py'))
fixture_support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_support)


def process_start(pid):
    return subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='],
                                   text=True, timeout=2).strip()


class NativeSession:
    def __init__(self, binary, root, cap=4 * 1024**2, action='run', selected=None,
                 margin=1024**3):
        import lance
        self.root = root
        self.nonce = 'independent-native-acceptance'
        self.owner = Path(str(root.parent) + '.lease') / 'exclusive-intent' / 'owner.json'
        self.owner.parent.mkdir(parents=True, exist_ok=True)
        (self.owner.parent.parent / 'readers').mkdir(exist_ok=True)
        owner = {'pid': os.getpid(), 'processStart': process_start(os.getpid()),
                 'nonce': self.nonce, 'role': 'independent-acceptance',
                 'acquiredAt': int(time.time() * 1000)}
        self.owner.write_text(json.dumps(owner))
        ds = lance.dataset(str(root))
        self.request = {'protocolVersion': 2, 'action': action, 'store': str(root),
                        'expectedVersion': ds.version, 'totalWriteBudgetBytes': cap,
                        'freeSpaceMarginBytes': margin,
                        'leaseOwner': str(self.owner), 'leaseNonce': self.nonce,
                        'sourceLimitBytes': 1024**2}
        if selected is not None:
            self.request['selectedFragmentIds'] = selected
        self.stderr = tempfile.TemporaryFile(mode='w+t')
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.stderr,
                                        text=True, bufsize=1)
        owner['activeHelper'] = {'pid': self.process.pid,
                                'processStart': process_start(self.process.pid)}
        self.owner.write_text(json.dumps(owner))
        self.events = []
        self.send(json.dumps(self.request))

    def send(self, value=None):
        self.process.stdin.write((self.nonce if value is None else value) + '\n')
        self.process.stdin.flush()

    def next(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([self.process.stdout], [], [], 0.1)[0]:
                line = self.process.stdout.readline()
                if not line:
                    self.process.wait(timeout=5)
                    self.stderr.seek(0)
                    raise RuntimeError(f'native exit {self.process.returncode}: {self.stderr.read()}')
                event = json.loads(line)
                self.events.append(event)
                return event
        raise TimeoutError('Native phase deadline exceeded')

    def reach(self, phase):
        for _ in range(8):
            event = self.next()
            current = event.get('phase', event.get('admission'))
            if current == phase:
                return event
            if current not in ('launch', 'ready', 'protected-read-ready', 'reader-drain'):
                raise RuntimeError(f'unexpected native event {event}')
            self.send()
        raise RuntimeError('Too many native protocol phases')

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.communicate(timeout=5)
        self.stderr.close()


class BoundedNativeAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not fixture_support.AVAILABLE:
            raise unittest.SkipTest('pinned pylance 12.0.0 unavailable; NOT QUALIFIED')
        cls.binary = (os.environ.get('GMAX_BOUNDED_NATIVE_EXECUTABLE') or
                      os.environ.get('GMAX_BOUNDED_NATIVE'))
        if not cls.binary or not Path(cls.binary).is_file():
            raise unittest.SkipTest('actual native executable unavailable; NOT QUALIFIED')

    @staticmethod
    def prepare(home):
        root = Path(home) / 'store' / 'chunks.lance'
        root.parent.mkdir()
        ds = fixture_support.BoundedCleanupAcceptance.fixture(root)
        return root, ds

    def test_real_selected_batch_preserves_rows_indices_tags_and_both_readers(self):
        import lance
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-success-') as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            user_version = ds.tags.get_version('user-reader')
            user_reader = lance.dataset(str(root), version=user_version)
            user_digest = fixture_support.row_digest(user_reader)
            selected = [f.fragment_id for f in ds.get_fragments() if f.num_deletions]
            self.assertEqual(len(selected), 1)
            unselected = {f.fragment_id: f.metadata.to_json() for f in ds.get_fragments()
                          if f.fragment_id not in selected}
            session = NativeSession(self.binary, root, selected=selected)
            try:
                protected = session.reach('protected-read-ready')
                old_reader = lance.dataset(str(root), version=protected['beforeVersion'])
                self.assertEqual(fixture_support.row_digest(old_reader), digest)
                session.send()
                drain = session.reach('reader-drain')
                self.assertEqual(fixture_support.row_digest(old_reader), digest)
                current = lance.dataset(str(root))
                self.assertEqual(fixture_support.row_digest(current), digest)
                self.assertEqual(current.tags.get_version('user-reader'), user_version)
                self.assertEqual(fixture_support.row_digest(user_reader), user_digest)
                self.assertEqual({i['name'] for i in current.list_indices()},
                                 {'content_idx', 'id_idx', 'vector_idx'})
                self.assertEqual(current.to_table(full_text_query={
                    'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                self.assertEqual(current.to_table(full_text_query={
                    'query': 'unique2000', 'columns': ['content']})['id'].to_pylist(), [2000])
                self.assertEqual(current.to_table(nearest={
                    'column': 'vector', 'q': [0.] * 8, 'k': 5}).num_rows, 5)
                current_fragments = {f.fragment_id: f.metadata.to_json()
                                     for f in current.get_fragments()}
                for fragment_id, metadata in unselected.items():
                    self.assertEqual(current_fragments[fragment_id], metadata)
                self.assertEqual(sum(f.num_deletions for f in current.get_fragments()), 0)
                old_reader = None
                current = None
                session.send()
                result = session.next()
                self.assertEqual(result['status'], 'committed')
                self.assertLessEqual(result['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                self.assertEqual(sum(result[key] for key in (
                    'dataBytesWritten', 'indexBytesWritten', 'metadataBytesWritten',
                    'verificationBytesWritten')), result['totalBytesWritten'])
                self.assertGreater(result['indexBytesWritten'], 0)
                self.assertEqual(result['rowsVerified'], 64)
                session.process.wait(timeout=5)
                self.assertEqual(session.process.returncode, 0)
                fresh = lance.dataset(str(root))
                self.assertEqual(fixture_support.row_digest(fresh), digest)
                print(json.dumps({'nativeAcceptance': 'real-selected-batch',
                                  'result': result, 'allFieldsDigest': digest[1],
                                  'protectedPhase': protected, 'drainPhase': drain}))
            finally:
                session.close()

    def test_tiny_budget_never_corrupts_existing_rows_or_search(self):
        import lance
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-lowcap-') as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            original_files = fixture_support.file_state(root)
            session = NativeSession(self.binary, root, cap=1)
            try:
                while session.process.poll() is None:
                    try:
                        event = session.next(timeout=10)
                    except RuntimeError:
                        break
                    if event.get('phase', event.get('admission')) in (
                            'launch', 'ready', 'protected-read-ready', 'reader-drain'):
                        session.send()
                    else:
                        break
                session.process.wait(timeout=5)
                self.assertNotEqual(session.process.returncode, 0)
                self.assertIn('budget', self.failure_reason(session).lower())
                fresh = lance.dataset(str(root))
                self.assertEqual(fixture_support.row_digest(fresh), digest)
                self.assertEqual(fresh.to_table(full_text_query={
                    'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                after = fixture_support.file_state(root)
                self.assertTrue(all(after.get(name) == state for name, state in original_files.items()))
            finally:
                session.close()

    def test_insufficient_preflight_space_refuses_without_store_mutation(self):
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-preflight-') as home:
            root, _ = self.prepare(home)
            original_files = fixture_support.file_state(root)
            disk = os.statvfs(root)
            margin = disk.f_bavail * disk.f_frsize + 1024**3
            session = NativeSession(self.binary, root, margin=margin)
            try:
                self.drive_to_exit(session)
                self.assertNotEqual(session.process.returncode, 0)
                self.assertIn('free space', self.failure_reason(session).lower())
                self.assertEqual(fixture_support.file_state(root), original_files)
            finally:
                session.close()

    def test_per_write_space_loss_on_ci_owned_volume_refuses_before_data_copy(self):
        import lance
        base = os.environ.get('GMAX_BOUNDED_FIXTURE_BASE')
        if not base:
            self.skipTest('CI-owned small volume unavailable; space-loss NOT QUALIFIED')
        base = Path(base).resolve(strict=True)
        disk = os.statvfs(base)
        self.assertLessEqual(disk.f_blocks * disk.f_frsize, 256 * 1024**2,
                             'refuses filling any ordinary/large host volume')
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-space-loss-', dir=base) as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            disk = os.statvfs(root)
            cap = 4 * 1024**2
            margin = disk.f_bavail * disk.f_frsize - cap - 1024**2
            self.assertGreater(margin, 1024**2)
            session = NativeSession(self.binary, root, cap=cap, margin=margin)
            filler = Path(home) / 'external-volume-consumer'
            try:
                session.reach('protected-read-ready')
                # Consume two MiB on the isolated CI volume, never on the host.
                with filler.open('wb') as handle:
                    handle.write(b'x' * (2 * 1024**2))
                    handle.flush()
                    os.fsync(handle.fileno())
                session.send()
                outcome = self.drive_to_exit(session)
                self.assertNotEqual(session.process.returncode, 0)
                self.assertEqual(outcome['phase'], 'error')
                self.assertEqual(outcome['dataBytesWritten'], 0)
                self.assertEqual(outcome['indexBytesWritten'], 0)
                self.assertLessEqual(outcome['totalBytesWritten'], cap)
                self.assertEqual(fixture_support.row_digest(lance.dataset(str(root))), digest)
                filler.unlink()
                frozen = fixture_support.file_state(root)
                retry = NativeSession(self.binary, root, cap=cap, margin=margin)
                try:
                    self.drive_to_exit(retry)
                    self.assertNotEqual(retry.process.returncode, 0)
                    self.assertEqual(fixture_support.file_state(root), frozen)
                finally:
                    retry.close()
                print(json.dumps({'nativeAcceptance': 'preventive-space-loss',
                                  'outcome': outcome, 'physicalENOSPC': False,
                                  'externalAllocatedPayloadBytes': 2 * 1024**2}))
            finally:
                session.close()

    def test_interruption_at_protected_and_committed_reader_windows_preserves_head(self):
        import lance
        for phase in ('protected-read-ready', 'reader-drain'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(
                    prefix='gmax-native-bounded-interrupted-') as home:
                root, ds = self.prepare(home)
                digest = fixture_support.row_digest(ds)
                session = NativeSession(self.binary, root)
                try:
                    paused = session.reach(phase)
                    session.process.kill()
                    session.process.communicate(timeout=5)
                    fresh = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(fresh), digest)
                    self.assertEqual(fresh.tags.get_version('user-reader'),
                                     ds.tags.get_version('user-reader'))
                    old_reader = lance.dataset(str(root), version=paused['beforeVersion'])
                    self.assertEqual(fixture_support.row_digest(old_reader), digest)
                    self.assertEqual(fresh.to_table(full_text_query={
                        'query': 'unique2000', 'columns': ['content']})['id'].to_pylist(), [2000])
                    frozen = fixture_support.file_state(root)
                    # A fresh run cannot discard uncertain state and copy again.
                    retry = NativeSession(self.binary, root)
                    try:
                        self.drive_to_exit(retry)
                        self.assertNotEqual(retry.process.returncode, 0)
                        self.assertEqual(fixture_support.file_state(root), frozen)
                    finally:
                        retry.close()
                    journals = list(root.glob('_gmax-maintenance-*.journal'))
                    self.assertEqual(len(journals), 1)
                    saved = journals[0].read_bytes()
                    self.assertGreaterEqual(len(saved), 80)
                    original_counts = struct.unpack('<6Q', saved[-80:-32])
                    recovered = NativeSession(self.binary, root, action='recover')
                    try:
                        result = self.drive_to_exit(recovered)
                        if phase == 'protected-read-ready':
                            self.assertNotEqual(recovered.process.returncode, 0)
                            self.assertEqual(fixture_support.file_state(root), frozen)
                        else:
                            self.assertEqual(recovered.process.returncode, 0)
                            self.assertEqual(result['status'], 'recovered')
                            self.assertEqual(result['dataBytesWritten'], original_counts[2])
                            self.assertEqual(result['indexBytesWritten'], original_counts[3])
                            self.assertGreaterEqual(result['totalBytesWritten'], original_counts[1])
                            self.assertLessEqual(result['totalBytesWritten'], recovered.request['totalWriteBudgetBytes'])
                            self.assertEqual(result['rowsVerified'], 64)
                            completed = lance.dataset(str(root))
                            self.assertEqual(fixture_support.row_digest(completed), digest)
                            self.assertEqual(set(completed.tags.list()), {'user-reader'})
                    finally:
                        recovered.close()
                    print(json.dumps({'nativeAcceptance': 'interrupted-readable-head',
                                      'phase': phase, 'paused': paused,
                                      'allFieldsDigest': digest[1]}))
                finally:
                    session.close()

    @staticmethod
    def drive_to_exit(session):
        result = None
        for _ in range(10):
            try:
                event = session.next(timeout=30)
            except RuntimeError:
                break
            if event.get('phase', event.get('admission')) in (
                    'launch', 'ready', 'protected-read-ready', 'reader-drain'):
                session.send()
            else:
                result = event
                break
        session.process.wait(timeout=5)
        return result

    @staticmethod
    def failure_reason(session):
        session.stderr.seek(0)
        return ' '.join(str(event.get('reason', '')) for event in session.events) + session.stderr.read()

    def test_mixed_index_coverage_is_preserved_or_refused_before_any_mutation(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-mixed-coverage-') as home:
            root, ds = self.prepare(home)
            tail = ds.to_table(filter='id >= 1920').to_pylist()
            for row in tail:
                row['id'] += 128
                row['content'] = f'tailneedle unique{row["id"]}'
            ds = lance.write_dataset(pa.Table.from_pylist(tail, schema=ds.schema),
                                     str(root), mode='append', max_rows_per_file=128)
            ds.delete('id >= 2048 AND id % 2 = 0')
            digest = fixture_support.row_digest(ds)
            selected = [f.fragment_id for f in ds.get_fragments() if f.num_deletions]
            self.assertEqual(len(selected), 2)
            before = fixture_support.file_state(root)
            session = NativeSession(self.binary, root, selected=selected)
            try:
                outcome = self.drive_to_exit(session)
                if session.process.returncode != 0:
                    # Unsupported coverage groups must fail before publishing
                    # a head, creating receipts/tags or copying any fragments.
                    self.assertEqual(fixture_support.file_state(root), before)
                    self.assertIn('coverage', self.failure_reason(session).lower())
                    branch = 'safe-preflight-refusal'
                else:
                    self.assertEqual(outcome['status'], 'committed')
                    fresh = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(fresh), digest)
                    self.assertEqual(fresh.to_table(full_text_query={
                        'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                    self.assertEqual(fresh.to_table(full_text_query={
                        'query': 'unique2051', 'columns': ['content']})['id'].to_pylist(), [2051])
                    self.assertEqual({index['name'] for index in fresh.list_indices()},
                                     {'content_idx', 'id_idx', 'vector_idx'})
                    self.assertLessEqual(outcome['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                    branch = 'mixed-coverage-preserved'
                print(json.dumps({'nativeAcceptance': 'mixed-index-coverage', 'branch': branch}))
            finally:
                session.close()


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BoundedNativeAcceptance)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    evidence = {
        'verdict': ('PASS_BOUNDED_NATIVE_ACCEPTANCE' if result.wasSuccessful()
                    and result.testsRun > 0 and not result.skipped else 'FAIL_BOUNDED_NATIVE_ACCEPTANCE'),
        'engine': '12.0.0',
        'tests': {'executed': result.testsRun,
                  'passed': max(0, result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped)),
                  'skipped': len(result.skipped), 'failures': len(result.failures), 'errors': len(result.errors)},
        'scope': ['small indexed selected-fragment run, exact live IDs/all fields',
                  'FTS/ANN, unselected fragments and user tags preserved',
                  'old/current snapshots read at deterministic native pauses',
                  '1-byte cap refusal preserves original store files and readable head',
                  'fresh preflight and per-write loss of free-space reservation refused',
                  'SIGKILL before copy and after commit; duplicate run refused',
                  'committed recovery keeps cumulative budget and writes no further data/index payloads'],
        'limits': ['payload-byte cap excludes physical filesystem metadata/journal allocation',
                   'no production store or process accessed',
                   'not a sustained latency or live disk-growth qualification',
                   'physical ENOSPC fixture has not been executed by this runner'],
    }
    output = os.environ.get('GMAX_BOUNDED_EVIDENCE')
    if output:
        Path(output).write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))
    raise SystemExit(0 if evidence['verdict'] == 'PASS_BOUNDED_NATIVE_ACCEPTANCE' else 1)

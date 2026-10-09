"""Independent actual-mutation acceptance for the metered Lance 12 executable.

GMAX_BOUNDED_NATIVE_EXECUTABLE must name the candidate executable. Ordinary
discovery skips unavailable native dependencies; this standalone runner fails
qualification on any skipped test. Every store and owner marker is private
to a small temporary fixture; no production process or store is accessed.
"""
import importlib.util
import hashlib
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
                 margin=1024**3, qualification=None):
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
        if qualification:
            self.request.update(qualification)
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
    def prepare(home, deleted=True):
        import pyarrow as pa
        root = Path(home) / 'store' / 'chunks.lance'
        root.parent.mkdir()
        ds = fixture_support.BoundedCleanupAcceptance.fixture(root, deleted=deleted)
        # Match gmax's string-path BTree and exercise fragments with multiple
        # immutable data files, alongside the existing FTS and IVF_FLAT index.
        ds.merge(pa.table({'id': pa.array(range(2048), type=pa.int32()),
                           'path': [f'/fixture/β/{i}.ts' for i in range(2048)]}),
                 left_on='id')
        ds.create_scalar_index('path', 'BTREE', name='path_idx')
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
            ds = None
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
                                 {'content_idx', 'id_idx', 'path_idx', 'vector_idx'})
                self.assertEqual(current.to_table(filter="path = '/fixture/β/11.ts'")['id'].to_pylist(), [11])
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

    def test_no_work_handshake_and_result_are_read_only(self):
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-nowork-') as home:
            root, _ = self.prepare(home, deleted=False)
            original_files = fixture_support.file_state(root)
            session = NativeSession(self.binary, root)
            try:
                ready = session.reach('ready')
                self.assertEqual(ready['plan']['status'], 'no-work')
                session.send()
                result = session.next()
                self.assertEqual(result['phase'], 'result')
                self.assertEqual(result['status'], 'no-work')
                self.assertEqual(result['totalBytesWritten'], 0)
                session.process.wait(timeout=5)
                self.assertEqual(session.process.returncode, 0)
                self.assertEqual(fixture_support.file_state(root), original_files)
            finally:
                session.close()

    def test_production_executable_rejects_qualification_fault_fields(self):
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-no-fault-hooks-') as home:
            root, ds = self.prepare(home)
            ds = None
            original_files = fixture_support.file_state(root)
            for fields in ({'qualificationFailPathPrefix': '_indices/'},
                           {'qualificationPauseAfterFirstTagDelete': True}):
                with self.subTest(fields=fields):
                    session = NativeSession(self.binary, root, qualification=fields)
                    try:
                        self.drive_to_exit(session)
                        self.assertNotEqual(session.process.returncode, 0)
                        self.assertIn('unknown field', self.failure_reason(session).lower())
                        self.assertEqual(fixture_support.file_state(root), original_files)
                    finally:
                        session.close()

    def test_pre_receipt_zero_payload_journal_is_safely_retired_on_admitted_attempt(self):
        import lance
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-admission-orphan-') as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            ds = None
            identity = 'a' * 64
            journal = root / f'_gmax-maintenance-{identity}.journal'
            log = root / f'_gmax-owned-{identity}.jsonl'
            # Exact durable initial record produced before the fixed receipt
            # exists. It records its own 80 bytes and no attempted payload.
            counters = struct.pack('<6Q', 4 * 1024**2, 80, 0, 0, 80, 0)
            journal.write_bytes(counters + hashlib.sha256(counters).digest())
            log.write_bytes(b'')
            session = NativeSession(self.binary, root)
            try:
                result = self.drive_to_exit(session)
                self.assertEqual(session.process.returncode, 0, self.failure_reason(session))
                self.assertEqual(result['status'], 'committed')
                self.assertFalse(journal.exists())
                self.assertFalse(log.exists())
                self.assertEqual(len(list(root.glob('_gmax-maintenance-*.journal'))), 1)
                self.assertEqual(len(list(root.glob('_gmax-owned-*.jsonl'))), 1)
                self.assertEqual(fixture_support.row_digest(lance.dataset(str(root))), digest)
                print(json.dumps({'nativeAcceptance': 'pre-receipt-metadata-retirement',
                                  'zeroPayloadOrphanRetired': True, 'result': result}))
            finally:
                session.close()

    def test_string_ids_and_multiple_selected_unindexed_fragments(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-string-ids-') as home:
            root = Path(home) / 'store' / 'chunks.lance'
            root.parent.mkdir()
            schema = pa.schema([('id', pa.string()), ('line', pa.int32()),
                                ('content', pa.string()), ('path', pa.string()),
                                ('payload', pa.binary()), ('symbols', pa.list_(pa.string())),
                                ('vector', pa.list_(pa.float32(), 8))])
            rows = [{'id': f'β-{i:05d}', 'line': i, 'content': f'function {i}',
                     'path': f'/fixture/{i}.ts', 'payload': None if i % 3 else bytes([i % 256]),
                     'symbols': None if i % 5 else [f'symbol{i}', 'β'],
                     'vector': [float(i % 7)] * 8} for i in range(512)]
            ds = lance.write_dataset(pa.Table.from_pylist(rows, schema=schema),
                                     str(root), max_rows_per_file=64, max_rows_per_group=32)
            ds.tags.create('user-reader', ds.version)
            ds.delete('line < 128 AND line % 2 = 0')
            digest = fixture_support.row_digest(ds)
            selected = [f.fragment_id for f in ds.get_fragments() if f.num_deletions]
            self.assertEqual(len(selected), 2)
            unchanged = {f.fragment_id: f.metadata.to_json() for f in ds.get_fragments()
                         if f.fragment_id not in selected}
            ds = None
            session = NativeSession(self.binary, root, selected=selected)
            try:
                result = self.drive_to_exit(session)
                self.assertEqual(session.process.returncode, 0, self.failure_reason(session))
                self.assertEqual(result['status'], 'committed')
                self.assertEqual(result['rowsVerified'], 64)
                self.assertEqual(result['indexBytesWritten'], 0)
                self.assertLessEqual(result['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                current = lance.dataset(str(root))
                self.assertEqual(fixture_support.row_digest(current), digest)
                self.assertEqual(set(current.tags.list()), {'user-reader'})
                self.assertEqual(sum(f.num_deletions for f in current.get_fragments()), 0)
                fragments = {f.fragment_id: f.metadata.to_json() for f in current.get_fragments()}
                for fragment_id, metadata in unchanged.items():
                    self.assertEqual(fragments[fragment_id], metadata)
                print(json.dumps({'nativeAcceptance': 'string-ids-multi-fragment',
                                  'selectedFragmentIds': selected, 'result': result,
                                  'allFieldsDigest': digest[1]}))
            finally:
                session.close()

    def test_budget_exhaustion_after_data_copy_is_safe_and_never_refunded(self):
        import lance
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-midcap-') as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            selected = [f for f in ds.get_fragments() if f.num_deletions]
            source = sum((root / 'data' / file.path).stat().st_size
                         for fragment in selected for file in fragment.metadata.files)
            index = sum(file.stat().st_size for entry in ds.list_indices()
                        for file in (root / '_indices' / entry['uuid']).rglob('*')
                        if file.is_file())
            # Admit the native preflight, but leave less than the remap payload
            # available after its independently reserved metadata finalization.
            cap = source + index + 64 * 1024
            self.assertLess(cap, 1024**2)
            original_fragments = {f.fragment_id: f.metadata.to_json() for f in ds.get_fragments()}
            original_indices = ds.list_indices()
            original_schema = ds.schema
            ds = None
            original_payload_files = {name: state for name, state in fixture_support.file_state(root).items()
                                      if name.startswith(('data/', '_indices/'))}
            session = NativeSession(self.binary, root, cap=cap)
            try:
                session.reach('protected-read-ready')
                session.send()
                outcome = self.drive_to_exit(session)
                self.assertNotEqual(session.process.returncode, 0)
                self.assertIn('budget', self.failure_reason(session).lower())
                self.assertGreater(outcome['dataBytesWritten'], 0)
                self.assertLessEqual(outcome['totalBytesWritten'], cap)
                current = lance.dataset(str(root))
                self.assertEqual(current.schema, original_schema)
                self.assertEqual(current.list_indices(), original_indices)
                self.assertEqual({f.fragment_id: f.metadata.to_json() for f in current.get_fragments()},
                                 original_fragments)
                self.assertEqual(fixture_support.row_digest(current), digest)
                self.assertEqual(current.to_table(full_text_query={
                    'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                current = None
                recovered = NativeSession(self.binary, root, cap=cap, action='recover')
                try:
                    result = self.drive_to_exit(recovered)
                    self.assertEqual(recovered.process.returncode, 0, self.failure_reason(recovered))
                    self.assertTrue(result['aborted'])
                    self.assertFalse(result['recoveryPending'])
                    self.assertEqual(result['rowsVerified'], 0)
                    self.assertEqual(result['dataBytesWritten'], outcome['dataBytesWritten'])
                    self.assertEqual(result['indexBytesWritten'], outcome['indexBytesWritten'])
                    self.assertGreaterEqual(result['totalBytesWritten'], outcome['totalBytesWritten'])
                    self.assertLessEqual(result['totalBytesWritten'], cap)
                    current = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(current), digest)
                    self.assertEqual(set(current.tags.list()), {'user-reader'})
                    current = None
                    restored_payload_files = {name: state for name, state in fixture_support.file_state(root).items()
                                              if name.startswith(('data/', '_indices/'))}
                    self.assertEqual(restored_payload_files, original_payload_files)
                finally:
                    recovered.close()
                frozen = fixture_support.file_state(root)
                retry = NativeSession(self.binary, root, cap=cap)
                try:
                    ready = retry.reach('ready')
                    self.assertEqual(ready['plan']['status'], 'qualified')
                    # Planning the next batch is allowed after exact orphan
                    # reclamation. Kill before its ready acknowledgement, so
                    # this test never performs another copy.
                    retry.process.kill()
                    retry.process.communicate(timeout=5)
                    self.assertEqual(fixture_support.file_state(root), frozen)
                finally:
                    retry.close()
                print(json.dumps({'nativeAcceptance': 'mid-copy-budget-exhaustion',
                                  'preflightCapBytes': cap, 'outcome': outcome,
                                  'abortRecovery': result, 'freshPlanAfterReclamation': True}))
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
            ds = None
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
                journal = next(root.glob('_gmax-maintenance-*.journal'))
                saved_counts = struct.unpack('<6Q', journal.read_bytes()[-80:-32])
                recovery = NativeSession(self.binary, root, action='recover', cap=cap,
                                         margin=margin)
                try:
                    recovered = self.drive_to_exit(recovery)
                    self.assertEqual(recovery.process.returncode, 0)
                    self.assertTrue(recovered['aborted'])
                    self.assertEqual(recovered['rowsVerified'], 0)
                    self.assertEqual(recovered['dataBytesWritten'], saved_counts[2])
                    self.assertEqual(recovered['indexBytesWritten'], saved_counts[3])
                    self.assertGreaterEqual(recovered['totalBytesWritten'], saved_counts[1])
                    self.assertLessEqual(recovered['totalBytesWritten'], cap)
                    restored = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(restored), digest)
                    self.assertEqual(set(restored.tags.list()), {'user-reader'})
                    restored = None
                finally:
                    recovery.close()
                print(json.dumps({'nativeAcceptance': 'preventive-space-loss',
                                  'outcome': outcome, 'physicalENOSPC': False,
                                  'abortRecovery': recovered,
                                  'externalAllocatedPayloadBytes': 2 * 1024**2}))
            finally:
                session.close()

    def test_recovery_uses_remaining_original_cap_after_its_own_space_consumption(self):
        import lance
        base = os.environ.get('GMAX_BOUNDED_FIXTURE_BASE')
        if not base:
            self.skipTest('CI-owned small volume unavailable; remaining-cap recovery NOT QUALIFIED')
        base = Path(base).resolve(strict=True)
        disk = os.statvfs(base)
        self.assertLessEqual(disk.f_blocks * disk.f_frsize, 256 * 1024**2)
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-spent-cap-', dir=base) as home:
            root, ds = self.prepare(home)
            digest = fixture_support.row_digest(ds)
            ds = None
            disk = os.statvfs(root)
            cap = 4 * 1024**2
            margin = disk.f_bavail * disk.f_frsize - cap - 128 * 1024
            self.assertGreater(margin, cap)
            session = NativeSession(self.binary, root, cap=cap, margin=margin)
            try:
                paused = session.reach('reader-drain')
                counts = struct.unpack('<6Q', next(root.glob('_gmax-maintenance-*.journal')).read_bytes()[-80:-32])
                disk = os.statvfs(root)
                free = disk.f_bavail * disk.f_frsize
                self.assertLess(free, cap + margin,
                                'fixture must actually cross the obsolete full-cap admission threshold')
                self.assertGreaterEqual(free, cap - counts[1] + margin,
                                        'remaining durable cap plus margin must still fit')
                session.process.kill()
                session.process.communicate(timeout=5)
                recovery = NativeSession(self.binary, root, cap=cap, margin=margin, action='recover')
                try:
                    result = self.drive_to_exit(recovery)
                    self.assertEqual(recovery.process.returncode, 0, self.failure_reason(recovery))
                    self.assertEqual(result['status'], 'recovered')
                    self.assertFalse(result['aborted'])
                    self.assertFalse(result['recoveryPending'])
                    self.assertEqual(result['dataBytesWritten'], counts[2])
                    self.assertEqual(result['indexBytesWritten'], counts[3])
                    self.assertGreaterEqual(result['totalBytesWritten'], counts[1])
                    self.assertLessEqual(result['totalBytesWritten'], cap)
                    current = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(current), digest)
                    self.assertEqual(set(current.tags.list()), {'user-reader'})
                finally:
                    recovery.close()
                print(json.dumps({'nativeAcceptance': 'remaining-original-cap-recovery',
                                  'freeBytesAtInterruption': free, 'originalCapBytes': cap,
                                  'durablySpentBytes': counts[1], 'marginBytes': margin,
                                  'paused': paused, 'recovered': result}))
            finally:
                session.close()

    def test_interruption_at_protected_and_committed_reader_windows_preserves_head(self):
        import lance
        for phase in ('protected-read-ready', 'reader-drain'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(
                    prefix='gmax-native-bounded-interrupted-') as home:
                root, ds = self.prepare(home)
                digest = fixture_support.row_digest(ds)
                user_version = ds.tags.get_version('user-reader')
                ds = None
                session = NativeSession(self.binary, root)
                try:
                    paused = session.reach(phase)
                    session.process.kill()
                    session.process.communicate(timeout=5)
                    fresh = lance.dataset(str(root))
                    self.assertEqual(fixture_support.row_digest(fresh), digest)
                    self.assertEqual(fresh.tags.get_version('user-reader'),
                                     user_version)
                    old_reader = lance.dataset(str(root), version=paused['beforeVersion'])
                    self.assertEqual(fixture_support.row_digest(old_reader), digest)
                    self.assertEqual(fresh.to_table(full_text_query={
                        'query': 'unique2000', 'columns': ['content']})['id'].to_pylist(), [2000])
                    old_reader = None
                    fresh = None
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
                        self.assertEqual(recovered.process.returncode, 0)
                        self.assertEqual(result['status'], 'recovered')
                        self.assertEqual(result['dataBytesWritten'], original_counts[2])
                        self.assertEqual(result['indexBytesWritten'], original_counts[3])
                        self.assertGreaterEqual(result['totalBytesWritten'], original_counts[1])
                        self.assertLessEqual(result['totalBytesWritten'], recovered.request['totalWriteBudgetBytes'])
                        self.assertEqual(result['aborted'], phase == 'protected-read-ready')
                        self.assertEqual(result['rowsVerified'],
                                         0 if phase == 'protected-read-ready' else 64)
                        completed = lance.dataset(str(root))
                        self.assertEqual(fixture_support.row_digest(completed), digest)
                        self.assertEqual(set(completed.tags.list()), {'user-reader'})
                        completed = None
                        finalized = fixture_support.file_state(root)
                        duplicate_recovery = NativeSession(self.binary, root, action='recover')
                        try:
                            duplicate_result = self.drive_to_exit(duplicate_recovery)
                            self.assertEqual(duplicate_recovery.process.returncode, 0)
                            self.assertEqual(duplicate_result['status'], 'no-work')
                            self.assertEqual(duplicate_result['totalBytesWritten'], 0)
                            self.assertEqual(duplicate_result['dataBytesWritten'], 0)
                            self.assertEqual(duplicate_result['indexBytesWritten'], 0)
                            self.assertEqual(fixture_support.file_state(root), finalized)
                        finally:
                            duplicate_recovery.close()
                    finally:
                        recovered.close()
                    print(json.dumps({'nativeAcceptance': 'interrupted-readable-head',
                                      'phase': phase, 'paused': paused,
                                      'recovered': result,
                                      'allFieldsDigest': digest[1]}))
                finally:
                    session.close()

    def test_corrupt_receipt_or_counter_refuses_without_fallback_copy(self):
        import lance
        for evidence in ('receipt', 'counter'):
            with self.subTest(evidence=evidence), tempfile.TemporaryDirectory(
                    prefix='gmax-native-bounded-corrupt-') as home:
                root, ds = self.prepare(home)
                digest = fixture_support.row_digest(ds)
                ds = None
                interrupted = NativeSession(self.binary, root)
                try:
                    interrupted.reach('protected-read-ready')
                    interrupted.process.kill()
                    interrupted.process.communicate(timeout=5)
                finally:
                    interrupted.close()
                if evidence == 'receipt':
                    target = root / '_gmax-bounded-receipt.json'
                    target.write_bytes(target.read_bytes()[:-1])
                else:
                    target = next(root.glob('_gmax-maintenance-*.journal'))
                    damaged = bytearray(target.read_bytes())
                    damaged[-1] ^= 1
                    target.write_bytes(damaged)
                frozen = fixture_support.file_state(root)
                recovery = NativeSession(self.binary, root, action='recover')
                try:
                    self.drive_to_exit(recovery)
                    self.assertNotEqual(recovery.process.returncode, 0)
                    self.assertEqual(fixture_support.file_state(root), frozen)
                    self.assertEqual(fixture_support.row_digest(lance.dataset(str(root))), digest)
                finally:
                    recovery.close()
                fresh_run = NativeSession(self.binary, root)
                try:
                    self.drive_to_exit(fresh_run)
                    self.assertNotEqual(fresh_run.process.returncode, 0)
                    self.assertEqual(fixture_support.file_state(root), frozen)
                finally:
                    fresh_run.close()
                print(json.dumps({'nativeAcceptance': 'corrupt-recovery-refusal',
                                  'evidence': evidence, 'headReadable': True,
                                  'storeUnchanged': True, 'fallbackCopy': False}))

    def test_verified_copy_recovery_preserves_subsequent_watched_edits(self):
        import lance
        import pyarrow as pa
        with tempfile.TemporaryDirectory(prefix='gmax-native-bounded-verified-advance-') as home:
            root, ds = self.prepare(home)
            original_digest = fixture_support.row_digest(ds)
            ds = None
            interrupted = NativeSession(self.binary, root)
            try:
                paused = interrupted.reach('reader-drain')
                interrupted.process.kill()
                interrupted.process.communicate(timeout=5)
            finally:
                interrupted.close()
            receipt = json.loads((root / '_gmax-bounded-receipt.json').read_text())
            self.assertEqual(receipt['phase'], 'verified')
            current = lance.dataset(str(root))
            copied_version = current.version
            self.assertEqual(fixture_support.row_digest(current), original_digest)
            appended = current.to_table(filter='id = 11').to_pylist()[0]
            appended.update(id=4096, content='ordinarywatcher unique4096',
                            path='/fixture/advanced-copy-edit.ts')
            current = lance.write_dataset(pa.Table.from_pylist([appended], schema=current.schema),
                                          str(root), mode='append', max_rows_per_file=128)
            current.delete('id = 13')
            edited_digest = fixture_support.row_digest(current)
            edited_version = current.version
            self.assertGreater(edited_version, copied_version)
            current = None
            counts = struct.unpack('<6Q', next(root.glob('_gmax-maintenance-*.journal')).read_bytes()[-80:-32])
            payloads = {name: state for name, state in fixture_support.file_state(root).items()
                        if name.startswith(('data/', '_indices/'))}
            recovery = NativeSession(self.binary, root, action='recover')
            try:
                result = self.drive_to_exit(recovery)
                self.assertEqual(recovery.process.returncode, 0, self.failure_reason(recovery))
                self.assertEqual(result['status'], 'recovered')
                self.assertFalse(result['aborted'])
                self.assertFalse(result['recoveryPending'])
                self.assertTrue(result['acceptedFinalization'])
                self.assertEqual(result['verifiedCopyVersion'], copied_version)
                self.assertEqual(result['afterVersion'], edited_version)
                self.assertEqual(result['rowsVerified'], 64)
                self.assertEqual(result['dataBytesWritten'], counts[2])
                self.assertEqual(result['indexBytesWritten'], counts[3])
                self.assertGreaterEqual(result['totalBytesWritten'], counts[1])
                self.assertLessEqual(result['totalBytesWritten'], recovery.request['totalWriteBudgetBytes'])
                self.assertEqual({name: state for name, state in fixture_support.file_state(root).items()
                                  if name.startswith(('data/', '_indices/'))}, payloads)
                current = lance.dataset(str(root))
                self.assertEqual(current.version, edited_version)
                self.assertEqual(fixture_support.row_digest(current), edited_digest)
                self.assertEqual(set(current.tags.list()), {'user-reader'})
                self.assertEqual(current.to_table(full_text_query={
                    'query': 'unique11', 'columns': ['content']})['id'].to_pylist(), [11])
                self.assertEqual(current.to_table(full_text_query={
                    'query': 'unique4096', 'columns': ['content']})['id'].to_pylist(), [4096])
                print(json.dumps({'nativeAcceptance': 'verified-copy-after-watched-edits',
                                  'paused': paused, 'copiedVersion': copied_version,
                                  'editedVersion': edited_version, 'allEditedFieldsDigest': edited_digest[1],
                                  'recovered': result}))
            finally:
                recovery.close()

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
                row['path'] = f'/fixture/β/{row["id"]}.ts'
            ds = lance.write_dataset(pa.Table.from_pylist(tail, schema=ds.schema),
                                     str(root), mode='append', max_rows_per_file=128)
            ds.delete('id >= 2048 AND id % 2 = 0')
            digest = fixture_support.row_digest(ds)
            selected = [f.fragment_id for f in ds.get_fragments() if f.num_deletions]
            self.assertEqual(len(selected), 2)
            ds = None
            before = fixture_support.file_state(root)
            session = NativeSession(self.binary, root, selected=selected)
            try:
                outcome = self.drive_to_exit(session)
                if session.process.returncode != 0:
                    # Unsupported coverage groups must fail before publishing
                    # a head, creating receipts/tags or copying any fragments.
                    self.assertEqual(fixture_support.file_state(root), before)
                    reason = self.failure_reason(session).lower()
                    self.assertTrue('coverage' in reason or 'plan' in reason, reason)
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
                                     {'content_idx', 'id_idx', 'path_idx', 'vector_idx'})
                    self.assertLessEqual(outcome['totalBytesWritten'], session.request['totalWriteBudgetBytes'])
                    branch = 'mixed-coverage-preserved'
                print(json.dumps({'nativeAcceptance': 'mixed-index-coverage', 'branch': branch}))
            finally:
                session.close()


if __name__ == '__main__':
    class TrackingResult(unittest.TextTestResult):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.executed_cases = []

        def startTest(self, test):
            self.executed_cases.append(test._testMethodName)
            super().startTest(test)

    def binary_digest():
        binary = (os.environ.get('GMAX_BOUNDED_NATIVE_EXECUTABLE') or
                  os.environ.get('GMAX_BOUNDED_NATIVE'))
        if not binary or not Path(binary).is_file():
            return None
        digest = hashlib.sha256()
        with open(binary, 'rb') as handle:
            for block in iter(lambda: handle.read(1024**2), b''):
                digest.update(block)
        return digest.hexdigest()

    def native_source_digest():
        root = REPO / 'lance-maintenance' / 'native'
        files = [root / 'Cargo.toml', root / 'Cargo.lock', *root.joinpath('src').rglob('*.rs')]
        digest = hashlib.sha256()
        for path in sorted(files, key=lambda file: file.relative_to(root).as_posix()):
            relative = path.relative_to(root).as_posix()
            payload = path.read_bytes()
            digest.update(f'{len(relative.encode())}:{relative}:{len(payload)}:'.encode())
            digest.update(payload)
        return digest.hexdigest()

    binary_sha256 = binary_digest()
    source_digest = native_source_digest()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BoundedNativeAcceptance)
    result = unittest.TextTestRunner(verbosity=2, resultclass=TrackingResult).run(suite)
    provenance_unchanged = (binary_sha256 is not None and binary_digest() == binary_sha256
                            and native_source_digest() == source_digest)
    evidence = {
        'schemaVersion': 1,
        'binarySha256': binary_sha256,
        'sourceDigest': source_digest,
        'provenanceUnchanged': provenance_unchanged,
        'testCases': result.executed_cases,
        'verdict': ('PASS_BOUNDED_NATIVE_ACCEPTANCE' if result.wasSuccessful()
                    and result.testsRun > 0 and not result.skipped and provenance_unchanged
                    else 'FAIL_BOUNDED_NATIVE_ACCEPTANCE'),
        'engine': '12.0.0',
        'tests': {'executed': result.testsRun,
                  'passed': max(0, result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped)),
                  'skipped': len(result.skipped), 'failures': len(result.failures), 'errors': len(result.errors)},
        'scope': ['small indexed selected-fragment run, exact live IDs/all fields',
                  'FTS/ANN, unselected fragments and user tags preserved',
                  'old/current snapshots read at deterministic native pauses',
                  '1-byte cap refusal preserves original store files and readable head',
                  'post-copy budget exhaustion preserves head; abort never refunds or recopies',
                  'fresh preflight and per-write loss of free-space reservation refused',
                  'SIGKILL before copy and after commit; duplicate run refused',
                  'safe abort and committed recovery release owned tags without more data/index writes',
                  'recovery keeps cumulative budget; finalized recovery is read-only no-work',
                  'remaining allowance admits recovery after the original attempt consumes free space',
                  'verified copy recovery preserves newer watched edits and search results',
                  'corrupt receipts/counters refuse without mutations or fallback copying',
                  'pre-receipt zero-payload custom files retire within a subsequent admitted attempt',
                  'production executable rejects qualification-only fault request fields'],
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

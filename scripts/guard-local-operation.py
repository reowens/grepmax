#!/usr/bin/env python3
"""Run one explicitly authorized Linux operation in an owned no-swap cgroup.

This is an operational wrapper, not authorization to run tests or workloads.
The existing delegated parent is unchanged; the supervisor stays outside the job.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import uuid

GIB = 1024**3
ROOT = Path('/sys/fs/cgroup')


def fields(file):
    return dict(line.split(maxsplit=1) for line in file.read_text().splitlines())


def status(pid):
    data = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    if data['State'].strip().startswith('Z'):
        return {'VmRSS': 0, 'VmSwap': 0}
    return {k: int(data[k].split()[0]) * 1024 for k in ('VmRSS', 'VmSwap')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--cwd', type=Path, required=True)
    parser.add_argument('--operation', required=True)
    parser.add_argument('--no-autostart', action='store_true')
    parser.add_argument('--owned-marker-receipt', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command after -- is required')
    if args.receipt.exists() or args.log.exists():
        parser.error('refusing to overwrite an earlier receipt/log')
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.log.parent.mkdir(parents=True, exist_ok=True)
    cpus = sorted(os.sched_getaffinity(0))[:2]
    os.sched_setaffinity(0, cpus)
    os.setpriority(os.PRIO_PROCESS, 0, max(10, os.getpriority(os.PRIO_PROCESS, 0)))
    current = Path('/proc/self/cgroup').read_text().strip()
    if not current.startswith('0::/') or '\n' in current:
        raise RuntimeError('unified cgroup identity unavailable')
    parent = (ROOT / current[3:].lstrip('/')).parent
    group = parent / ('gmax-operation-' + uuid.uuid4().hex)
    relative = '/' + str(group.relative_to(ROOT))
    started = time.monotonic()
    child = None
    identity = None
    initial = None
    last = None
    result = {'revision': 3, 'operation': args.operation, 'host': socket.gethostname(),
              'kernel': os.uname().release, 'cgroup': relative,
              'limits': {'cpus': cpus, 'niceAtLeast': 10, 'maxOwnedRssBytes': 2*GIB,
                         'deadlineSeconds': 180, 'minAvailableBytes': 8*GIB,
                         'maxJobSwapBytes': 0, 'hostSwapAllocationDiagnosticOnly': True},
              'firstFailure': None, 'cleanupErrors': [], 'commandStarted': False}

    def fail(reason, phase, sample=None):
        if result['firstFailure'] is None:
            result['firstFailure'] = {'reason': reason, 'phase': phase,
                                      'sample': sample, 'monotonicNs': time.monotonic_ns(),
                                      'utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def verify_identity():
        st = group.stat()
        if (st.st_dev, st.st_ino) != identity:
            raise RuntimeError('owned cgroup identity changed')

    def pids():
        verify_identity()
        if int(fields(group/'cgroup.stat')['nr_descendants']) != 0:
            raise RuntimeError('unexpected nested job cgroup')
        return [int(value) for value in (group/'cgroup.procs').read_text().split()]

    def containment():
        home = Path.home()/'.gmax'
        if os.path.lexists(home/'safety-stop.json'):
            raise RuntimeError('host safety stop present')
        marker = home/'autostart-disabled'
        if os.path.lexists(marker):
            if args.owned_marker_receipt is None:
                raise RuntimeError('autostart quarantine present')
            proof = json.loads(args.owned_marker_receipt.read_text())
            st = marker.stat()
            if ([st.st_dev, st.st_ino] != proof['identity'] or
                    hashlib.sha256(marker.read_bytes()).hexdigest() != proof['sha256'] or
                    proof['ownerPid'] not in pids()):
                raise RuntimeError('autostart marker not owned by this operation')

    def sample():
        verify_identity()
        mem = {k: int(v.split()[0])*1024 for k,v in
               (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
        vm = fields(Path('/proc/vmstat'))
        members = pids()
        own = status(os.getpid())
        rss = own['VmRSS']
        for pid in members:
            try:
                rss += status(pid)['VmRSS']
            except FileNotFoundError:
                if pid in pids():
                    raise
        return {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'monotonicNs': time.monotonic_ns(), 'availableBytes': mem['MemAvailable'],
                'hostSwapAllocatedBytes': mem['SwapTotal']-mem['SwapFree'],
                'hostOomKills': int(vm['oom_kill']), 'pswpinPages': int(vm['pswpin']),
                'pswpoutPages': int(vm['pswpout']),
                'hostMemoryPsi': Path('/proc/pressure/memory').read_text().strip(),
                'jobSwapMax': (group/'memory.swap.max').read_text().strip(),
                'jobSwapBytes': int((group/'memory.swap.current').read_text()),
                'jobSwapPeakBytes': int((group/'memory.swap.peak').read_text()),
                'jobZswapBytes': int((group/'memory.zswap.current').read_text()),
                'jobMemoryEvents': {k:int(v) for k,v in fields(group/'memory.events').items()},
                'jobSwapEvents': {k:int(v) for k,v in fields(group/'memory.swap.events').items()},
                'ownedRssBytes': rss, 'supervisorSwapBytes': own['VmSwap'],
                'jobProcessCount': len(members)}

    def check(value, phase):
        reasons = []
        if value['jobSwapMax'] != '0': reasons.append('job no-swap enforcement changed')
        if value['jobSwapBytes'] or value['jobSwapPeakBytes'] or value['jobZswapBytes']:
            reasons.append('owned job swap observed')
        if value['supervisorSwapBytes']: reasons.append('owned supervisor swap observed')
        if value['ownedRssBytes'] >= 2*GIB: reasons.append('owned RSS limit reached')
        if value['availableBytes'] < 8*GIB: reasons.append('host available-memory floor')
        if initial is not None and value['hostOomKills'] > initial['hostOomKills']:
            reasons.append('new host OOM kill')
        if value['jobMemoryEvents']['oom'] or value['jobMemoryEvents']['oom_kill']:
            reasons.append('job OOM event')
        if time.monotonic()-started > 180: reasons.append('operation deadline')
        containment()
        if reasons:
            fail('; '.join(reasons), phase, value)
            raise RuntimeError('; '.join(reasons))

    def interrupted(_signal, _frame):
        raise RuntimeError('guard supervisor interrupted')

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if 'memory' not in (parent/'cgroup.subtree_control').read_text().split():
            raise RuntimeError('memory controller not delegated')
        group.mkdir(mode=0o700)
        st = group.stat(); identity = (st.st_dev, st.st_ino)
        (group/'memory.swap.max').write_text('0\n')
        if (group/'memory.swap.max').read_text().strip() != '0' or pids():
            raise RuntimeError('empty no-swap job admission failed')
        if not os.access(group/'cgroup.kill', os.W_OK):
            raise RuntimeError('whole-cohort cleanup unavailable')
        initial = last = sample()
        result['admission'] = initial
        check(initial, 'admission')
        env = os.environ.copy()
        if args.no_autostart: env['GMAX_NO_AUTOSTART'] = '1'

        def enter_before_exec():
            # Popen does not exec the workload until this verified transfer returns.
            (group/'cgroup.procs').write_text(str(os.getpid()))
            if (Path('/proc/self/cgroup').read_text().strip() != '0::'+relative or
                    (group/'memory.swap.max').read_text().strip() != '0'):
                raise RuntimeError('job placement/enforcement verification failed')

        with args.log.open('x') as log:
            child = subprocess.Popen(command, cwd=args.cwd, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True,
                                     preexec_fn=enter_before_exec)
            result['commandStarted'] = True
            result['peakOwnedRssBytes'] = initial['ownedRssBytes']
            result['minimumAvailableBytes'] = initial['availableBytes']
            while True:
                last = sample()
                result['peakOwnedRssBytes'] = max(result['peakOwnedRssBytes'], last['ownedRssBytes'])
                result['minimumAvailableBytes'] = min(result['minimumAvailableBytes'], last['availableBytes'])
                check(last, 'running')
                if child.poll() is not None: break
                time.sleep(.25)
            result['exitCode'] = child.returncode
            if child.returncode: raise RuntimeError('operation command failed')
            if pids(): raise RuntimeError('owned descendants retained after command exit')
    except BaseException as error:
        # A failed metric read has no complete trigger sample. Keep the last
        # successful observation separate instead of labeling it as the trigger.
        fail(str(error), 'operation')
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup_deadline = time.monotonic()+3.5
        if identity is not None:
            try:
                try:
                    for pid in pids():
                        try:
                            fd = os.pidfd_open(pid)
                            try:
                                if Path(f'/proc/{pid}/cgroup').read_text().strip() == '0::'+relative:
                                    signal.pidfd_send_signal(fd, signal.SIGTERM)
                            finally: os.close(fd)
                        except (FileNotFoundError, ProcessLookupError): pass
                except BaseException as error:
                    result['cleanupErrors'].append(str(error))
                    fail(str(error), 'cleanup enumeration')
                    # Even lost PID visibility must not leave the owned cohort running.
                    verify_identity(); (group/'cgroup.kill').write_text('1\n')
                if fields(group/'cgroup.events')['populated'] != '0': time.sleep(.5)
                if fields(group/'cgroup.events')['populated'] != '0':
                    verify_identity(); (group/'cgroup.kill').write_text('1\n')
                end = cleanup_deadline
                while fields(group/'cgroup.events')['populated'] != '0' and time.monotonic()<end:
                    time.sleep(.05)
                if child is not None: child.wait(timeout=max(.1, end-time.monotonic()))
                result['cohortEmpty'] = fields(group/'cgroup.events')['populated'] == '0'
                if not result['cohortEmpty']: raise RuntimeError('owned cohort did not drain')
                final = sample(); result['final'] = final
                check(final, 'final')
            except BaseException as error:
                result['cleanupErrors'].append(str(error)); fail(str(error), 'cleanup')
                try:
                    verify_identity(); (group/'cgroup.kill').write_text('1\n')
                    if child is not None: child.wait(timeout=max(.1, cleanup_deadline-time.monotonic()))
                except BaseException as cleanup_error:
                    result['cleanupErrors'].append(str(cleanup_error))
            finally:
                try:
                    verify_identity(); group.rmdir(); result['ownedCgroupRemoved'] = True
                except BaseException as error:
                    result['cleanupErrors'].append(str(error)); fail(str(error), 'cgroup removal')
        result['lastObservedSample'] = last
        result['elapsedSeconds'] = time.monotonic()-started
        if initial is not None and 'final' in result:
            result['hostSwapAllocationDeltaBytes'] = result['final']['hostSwapAllocatedBytes']-initial['hostSwapAllocatedBytes']
        result['outcome'] = 'passed' if result['firstFailure'] is None else 'failed'
        args.receipt.write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result['outcome']=='passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())

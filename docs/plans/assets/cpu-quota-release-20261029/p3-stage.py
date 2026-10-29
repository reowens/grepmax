"""Stage the authorized public package without changing the serving install."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

REPO = Path('/home/reoiv/dev/hetchy/tools/gmax/.claude/worktrees/gmax-cpu-quota-release-026105')
SHARED = Path('/home/reoiv/.gmax')
STATE = Path('/home/reoiv/.local/state/gmax-handover/20261029T010000Z-0.26.105')
GIB = 1024**3


def memory():
    v = {line.split(':')[0]: int(line.split(':')[1].split()[0]) * 1024
         for line in Path('/proc/meminfo').read_text().splitlines()}
    return v['MemAvailable'], v['SwapTotal'] - v['SwapFree']


def owned(group):
    lines = subprocess.check_output(['/bin/ps', '-eo', 'pid=,pgid=,rss=,stat='], text=True, timeout=2).splitlines()
    return [(int(pid), int(rss) * 1024) for line in lines
            for pid, pgid, rss, status in [line.split()]
            if int(pgid) == group and not status.startswith('Z')]


def bound():
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    os.nice(10)


env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL') if key in os.environ}
env.update(GMAX_NO_AUTOSTART='1', npm_config_prefix=str(STATE / 'stage'),
           npm_config_registry='https://registry.npmjs.org', npm_config_audit='false',
           npm_config_fund='false', npm_config_update_notifier='false',
           npm_package_version='0.26.105', RAYON_NUM_THREADS='1',
           LANCE_CPU_THREADS='1', LANCE_IO_THREADS='2', MALLOC_ARENA_MAX='2')
command = ['python3', str(STATE/'prepare-stage.py')]
start = time.monotonic()
available,initial_swap = memory()
assert available >= 8*GIB, 'Staging host memory admission refused'
peak = 0
child = None
receipt = {'command': command, 'prefix': str(STATE / 'stage'),
           'liveInstallationChanged': False, 'serviceRestartSuppressed': True,
           'limits': {'deadlineSeconds': 180, 'maxOwnedRssBytes': 2 * GIB,
                      'minAvailableBytes': 8 * GIB, 'maxSwapGrowthBytes': 0,
                      'cpus': sorted(os.sched_getaffinity(0))[:2]}, 'outcome': 'incomplete'}
try:
    with (STATE / 'staging-install.log').open('w') as log:
        child = subprocess.Popen(command, cwd=REPO, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=bound)
        receipt['childPid'] = child.pid
        while child.poll() is None:
            for marker in ('safety-stop.json', 'autostart-disabled'):
                if (SHARED / marker).exists():
                    raise RuntimeError('Existing containment appeared during staging')
            available, swap = memory()
            peak = max(peak, sum(rss for _, rss in owned(child.pid)))
            if (time.monotonic() - start > 180 or peak > 2 * GIB
                    or available < 8 * GIB or swap - initial_swap > 0):
                raise RuntimeError('Staging resource/deadline guard refused continuation')
            time.sleep(0.25)
        receipt['exitCode'] = child.returncode
        receipt['outcome'] = 'completed' if child.returncode == 0 else 'failed'
except BaseException as error:
    receipt['outcome'] = 'failed'
    receipt['error'] = str(error)
finally:
    if child:
        if owned(child.pid):
            os.killpg(child.pid, signal.SIGTERM)
            time.sleep(0.5)
            if owned(child.pid):
                os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        receipt['noLiveOwnedProcesses'] = not owned(child.pid)
    available,swap=memory()
    receipt['finalAvailableBytes']=available;receipt['finalSwapGrowthBytes']=max(0,swap-initial_swap)
    if available<8*GIB or swap>initial_swap:
        receipt['outcome']='failed';receipt['error']='Final host resource guard refused continuation'
    receipt['elapsedSeconds'] = time.monotonic() - start
    receipt['peakSampledOwnedRssBytes'] = peak
    (STATE / 'staging-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)
raise SystemExit(0 if receipt['outcome'] == 'completed' else 1)

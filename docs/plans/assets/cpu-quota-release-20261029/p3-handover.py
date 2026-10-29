"""Authorized same-unit handover only; no FTS or maintenance action."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import time

STATE = Path('/home/reoiv/.local/state/gmax-handover/20261029T010000Z-0.26.105')
HOME_DIR = Path('/home/reoiv/.gmax')
INSTALL = Path('/home/reoiv/.local/lib/node_modules/grepmax')
UNIT = 'hetchy-gmax.service'
UNIT_FILE = Path('/home/reoiv/.config/systemd/user') / UNIT
MARKER = HOME_DIR / 'autostart-disabled'
NODE = '/usr/local/bin/node'
GIB = 1024**3
owned_marker = None
marker_sha = None


def save(name, value):
    (STATE / name).write_text(json.dumps(value, indent=2) + '\n')


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def identity(file):
    s = file.stat()
    return (s.st_dev, s.st_ino)


def dirs():
    return {name: identity(HOME_DIR / name) for name in ('lancedb', 'lancedb/chunks.lance', 'cache')}


def show():
    fields = ('MainPID', 'ControlGroup', 'ActiveState', 'SubState', 'CPUQuotaPerSecUSec', 'CPUWeight', 'Nice')
    out = subprocess.check_output(['systemctl', '--user', 'show', UNIT, *['--property=' + x for x in fields]], text=True, timeout=5)
    return dict(line.split('=', 1) for line in out.splitlines())


def ping(command=None):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(3)
        sock.connect(str(HOME_DIR / 'daemon.sock'))
        sock.sendall((json.dumps(command or {'cmd': 'ping'}) + '\n').encode())
        data = b''
        while b'\n' not in data:
            block = sock.recv(65536)
            if not block:
                raise RuntimeError('Daemon IPC closed')
            data += block
        return json.loads(data.split(b'\n')[0])


def safety():
    if os.path.lexists(HOME_DIR / 'safety-stop.json'):
        raise RuntimeError('Persistent host safety stop appeared; preserving it')
    if os.environ.get('GMAX_NO_AUTOSTART') == '1':
        raise RuntimeError('Environment quarantine remains authoritative')


def remove_owned_marker():
    safety()
    assert identity(MARKER) == owned_marker and sha(MARKER) == marker_sha, 'Autostart marker ownership changed'
    MARKER.unlink()


def wait_ready(version, seconds=180):
    started = time.monotonic()
    last_notice = started
    while time.monotonic() - started < seconds:
        safety()
        try:
            p, u = ping(), show()
            if (p.get('ready') and p.get('version') == version and p.get('pid') == int(u['MainPID'])
                    and p.get('operationStatus') == 'open' and p.get('service', {}).get('mode') == 'active'):
                return p, u
        except (OSError, ValueError, KeyError):
            pass
        if time.monotonic() - last_notice >= 30:
            print('Waiting for fresh ready/open admission on the existing service', flush=True)
            last_notice = time.monotonic()
        time.sleep(0.5)
    raise RuntimeError('Ready/open service admission deadline exceeded')


def memory():
    v = {line.split(':')[0]: int(line.split(':')[1].split()[0]) * 1024
         for line in Path('/proc/meminfo').read_text().splitlines()}
    return v['MemAvailable'], v['SwapTotal'] - v['SwapFree']


def owned(group):
    lines = subprocess.check_output(['/bin/ps', '-eo', 'pid=,pgid=,rss=,stat='], text=True, timeout=2).splitlines()
    return [(int(pid), int(rss) * 1024) for line in lines
            for pid, pgid, rss, state in [line.split()]
            if int(pgid) == group and not state.startswith('Z')]


def bound():
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    os.nice(10)



safety()
assert not os.path.lexists(MARKER), 'Preserving existing autostart quarantine'
assert json.loads((INSTALL / 'package.json').read_text())['version'] == '0.26.104'
config=json.loads((HOME_DIR/'config.json').read_text())
assert (config['modelTier'],config['embedMode'],config['vectorDim'],config['workerThreads'])==('small','cpu',384,4)
assert json.loads((STATE / 'stage-validation.json').read_text())['matchingFiles'] == 331
assert json.loads((STATE / 'dependency-compatibility.json').read_text())['ok']
p, u = wait_ready('0.26.104')
old_pid = p['pid']
assert Path(f'/proc/{old_pid}/cgroup').read_text().strip() == '0::' + u['ControlGroup']
old_start = Path(f'/proc/{old_pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
before = {'version': p['version'], 'ping': p, 'unit': u, 'oldPidStartTicks': old_start,
          'configSha256': sha(HOME_DIR / 'config.json'), 'unitSha256': sha(UNIT_FILE),
          'storeDirectoryIdentities': dirs(), 'at': time.time()}
save('before.json', before)
fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle:
    handle.write('owned approved 0.26.105 handover ' + str(STATE) + '\n')
    handle.flush()
    os.fsync(handle.fileno())
owned_marker, marker_sha = identity(MARKER), sha(MARKER)
save('marker.json', {'identity': owned_marker, 'sha256': marker_sha})
swapped = False
try:
    save('shutdown.json', ping({'cmd': 'shutdown', 'reason': 'approved-0.26.105-p3-handover',
         'from_pid': os.getpid(), 'from_ppid': os.getppid(), 'from_version': '0.26.105',
         'from_argv': ['python3', str(STATE / 'handover.py')]}))
    subprocess.run(['systemctl', '--user', 'stop', UNIT], check=True, timeout=100)
    old_proc = Path(f'/proc/{old_pid}/stat')
    if old_proc.exists():
        fields = old_proc.read_text().rsplit(')', 1)[1].split()
        assert fields[19] != old_start or fields[0] == 'Z', 'Predecessor remains alive'
    assert show()['MainPID'] == '0'
    safety()
    INSTALL.rename(STATE / 'previous-install')
    try:
        (STATE / 'stage/lib/node_modules/grepmax').rename(INSTALL)
    except BaseException:
        (STATE / 'previous-install').rename(INSTALL)
        raise
    swapped = True
    save('swap.json', {'version': '0.26.105', 'installed': str(INSTALL), 'rollback': str(STATE / 'previous-install'), 'at': time.time()})
    print('0.26.105 installed; starting the existing service for normal handover', flush=True)
    remove_owned_marker()
    safety()
    subprocess.run(['systemctl', '--user', 'start', UNIT], check=True, timeout=30)
    p, u = wait_ready('0.26.105')
    pid = p['pid']
    cg = Path('/sys/fs/cgroup' + u['ControlGroup'])
    limits = {'cpu.max': (cg / 'cpu.max').read_text().strip(), 'cpu.weight': (cg / 'cpu.weight').read_text().strip(), 'nice': os.getpriority(os.PRIO_PROCESS, pid)}
    assert limits == {'cpu.max': '200000 100000', 'cpu.weight': '10', 'nice': 10}, limits
    assert sha(HOME_DIR / 'config.json') == before['configSha256']
    assert sha(UNIT_FILE) == before['unitSha256']
    assert dirs() == before['storeDirectoryIdentities']
    assert Path(f'/proc/{pid}/cgroup').read_text().strip() == '0::' + u['ControlGroup']
    result = {'version': p['version'], 'pid': pid, 'ping': p, 'unit': u, 'kernelLimits': limits,
              'oldPidExited': old_pid, 'configPreserved': True, 'unitFilePreserved': True,
              'storeDirectoryIdentitiesPreserved': True, 'ownedAutostartMarkerRemoved': not os.path.lexists(MARKER),
              'safetyStopPresent': False, 'rollbackInstall': str(STATE / 'previous-install'),
              'productionMaintenanceInvoked': False, 'observedAt': time.time()}
    save('runtime-result.json', result)
    print(json.dumps({'version': result['version'], 'pid': pid, 'service': u['ActiveState'],
                      'limits': limits}), flush=True)
except BaseException as error:
    save('failure.json', {'error': repr(error), 'swapped': swapped, 'at': time.time()})
    helper_closed = True  # No native maintenance helper is started by this handover.
    # Never restart or replace packages while an owned native helper may live,
    # and never clear a new external safety/quarantine marker.
    marker_is_ours = os.path.lexists(MARKER) and identity(MARKER) == owned_marker and sha(MARKER) == marker_sha
    if helper_closed and not os.path.lexists(HOME_DIR / 'safety-stop.json') and (not os.path.lexists(MARKER) or marker_is_ours):
        subprocess.run(['systemctl', '--user', 'stop', UNIT], timeout=100)
        if swapped:
            INSTALL.rename(STATE / 'failed-install')
            (STATE / 'previous-install').rename(INSTALL)
        if marker_is_ours:
            remove_owned_marker()
        subprocess.run(['systemctl', '--user', 'start', UNIT], check=True, timeout=30)
        p, u = wait_ready('0.26.104')
        save('rollback.json', {'ping': p, 'unit': u, 'at': time.time()})
    raise

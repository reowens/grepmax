"""Contain one approved production-profile client; never signal the service."""
import hashlib,json,os,signal,subprocess,time
from pathlib import Path
STATE=Path('/home/reoiv/.local/state/gmax-profile/20261029T010000Z-0.26.105-production-search');HOME_DIR=Path('/home/reoiv/.gmax');INSTALL=Path('/home/reoiv/.local/lib/node_modules/grepmax');CGROUP=Path('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/hetchy-gmax.service');GIB=1024**3

def memory():
    v={line.split(':')[0]:int(line.split(':')[1].split()[0])*1024 for line in Path('/proc/meminfo').read_text().splitlines()};return v['MemAvailable'],v['SwapTotal']-v['SwapFree']
def owned(group):
    output=subprocess.check_output(['/bin/ps','-eo','pid=,pgid=,rss=,stat='],text=True,timeout=2)
    return [(int(pid),int(rss)*1024) for line in output.splitlines() for pid,pgid,rss,status in [line.split()] if int(pgid)==group and not status.startswith('Z')]
def process_rss(pid):
    try:
        values={line.split(':')[0]:line.split(':')[1].strip() for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line};return int(values.get('VmRSS','0 kB').split()[0])*1024
    except FileNotFoundError:return 0
def service():
    pids=[int(p) for p in (CGROUP/'cgroup.procs').read_text().split()];return pids,sum(process_rss(p) for p in pids)
def bound():
    os.sched_setaffinity(0,sorted(os.sched_getaffinity(0))[:2]);os.nice(10)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

assert not any(os.path.lexists(HOME_DIR/name) for name in ['safety-stop.json','autostart-disabled'])
config=json.loads((HOME_DIR/'config.json').read_text());assert (config['modelTier'],config['embedMode'],config['vectorDim'])==('small','cpu',384)
assert json.loads((INSTALL/'package.json').read_text())['version']=='0.26.105'
assert (CGROUP/'cpu.max').read_text().strip()=='200000 100000' and (CGROUP/'cpu.weight').read_text().strip()=='10'
available,initial_swap=memory();assert available>=8*GIB
initial_pids,initial_rss=service();daemon=int(subprocess.check_output(['systemctl','--user','show','hetchy-gmax.service','--property=MainPID','--value'],text=True).strip())
assert daemon in initial_pids
hash_paths=[HOME_DIR/'config.json',Path('/home/reoiv/.config/systemd/user/hetchy-gmax.service'),INSTALL/'dist/lib/search/searcher.js',INSTALL/'dist/lib/workers/pool.js',INSTALL/'dist/lib/daemon/search-handler.js']
hashes={str(path):sha(path) for path in hash_paths}
receipt={'outcome':'incomplete','profileInvocations':1,'testInvocations':0,'daemonPid':daemon,'initialServicePids':initial_pids,'initialServiceRssBytes':initial_rss,'sourceAndConfigHashes':hashes,'modelIdentity':config,'limits':{'deadlineSeconds':180,'requestTimeoutSeconds':20,'maxOwnedRssBytes':2*GIB,'minAvailableBytes':8*GIB,'maxSwapGrowthBytes':0,'maxServiceRssGrowthBytes':GIB,'maxDaemonRssBytes':2560*1024**2,'cpus':sorted(os.sched_getaffinity(0))[:2]},'serviceCpuMax':'200000 100000','serviceCpuWeight':'10','perfEventParanoid':Path('/proc/sys/kernel/perf_event_paranoid').read_text().strip()}
def interrupted(*_):raise KeyboardInterrupt('Profile controller interrupted')
signal.signal(signal.SIGTERM,interrupted)
child=None;peak=0;service_peak=initial_rss;minimum=available;swap_peak=0;seen=set();started=time.monotonic()
env={k:os.environ[k] for k in ['PATH','HOME','LANG','LC_ALL'] if k in os.environ};env.update(MALLOC_ARENA_MAX='2',NODE_OPTIONS='--max-old-space-size=128',GMAX_EMBED_MODE='cpu',LANCE_CPU_THREADS='1',LANCE_IO_THREADS='2',LANCE_AUTO_MIGRATION='false',RAYON_NUM_THREADS='1',TOKIO_WORKER_THREADS='1',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
try:
    with (STATE/'profile.log').open('w') as log:
        child=subprocess.Popen(['python3',str(STATE/'driver.py')],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=bound)
        receipt['childPid']=child.pid
        while child.poll() is None:
            group=owned(child.pid);seen.update(pid for pid,_ in group);peak=max(peak,sum(rss for _,rss in group));available,swap=memory();minimum=min(minimum,available);swap_peak=max(swap_peak,swap-initial_swap);pids,service_rss=service();service_peak=max(service_peak,service_rss)
            reason=None
            if time.monotonic()-started>180:reason='deadline'
            elif peak>2*GIB:reason='owned-rss'
            elif available<8*GIB:reason='host-available-memory'
            elif swap-initial_swap>0:reason='host-swap-growth'
            elif daemon not in pids:reason='service-process-changed'
            elif service_rss-initial_rss>GIB:reason='service-rss-growth'
            elif process_rss(daemon)>2560*1024**2:reason='daemon-rss-watermark'
            elif any(os.path.lexists(HOME_DIR/name) for name in ['safety-stop.json','autostart-disabled']):reason='containment-marker'
            if reason:raise RuntimeError('Production profile guard: '+reason)
            time.sleep(.25)
        receipt['exitCode']=child.returncode;receipt['outcome']='completed' if child.returncode==0 else 'failed-or-partial'
except BaseException as error:
    receipt['outcome']='failed-or-partial';receipt['error']=str(error)
finally:
    if child is not None:
        if owned(child.pid):
            os.killpg(child.pid,signal.SIGTERM);time.sleep(.5)
            if owned(child.pid):os.killpg(child.pid,signal.SIGKILL)
        child.wait(timeout=3);receipt['noLiveOwnedProcesses']=not owned(child.pid)
    available,swap=memory();minimum=min(minimum,available);swap_peak=max(swap_peak,swap-initial_swap);pids,final_rss=service();service_peak=max(service_peak,final_rss)
    receipt['finalSample']={'availableBytes':available,'swapGrowthBytes':max(0,swap-initial_swap),'serviceRssBytes':final_rss,'daemonRssBytes':process_rss(daemon)}
    if available<8*GIB or swap>initial_swap or final_rss-initial_rss>GIB or process_rss(daemon)>2560*1024**2:
        receipt['outcome']='failed-or-partial';receipt.setdefault('error','Production profile final resource guard refused continuation')
    receipt.update(elapsedSeconds=time.monotonic()-started,peakSampledOwnedRssBytes=peak,peakSampledServiceRssBytes=service_peak,minimumSampledAvailableBytes=minimum,maximumSampledSwapGrowthBytes=swap_peak,initialSwapUsedBytes=initial_swap,observedOwnedPids=sorted(seen),sourceConfigAndUnitPreserved=all(sha(path)==hashes[str(path)] for path in hash_paths),serviceCpuLimitsPreserved=(CGROUP/'cpu.max').read_text().strip()=='200000 100000' and (CGROUP/'cpu.weight').read_text().strip()=='10',serviceSignalsSent=False)
    (STATE/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2),flush=True)
raise SystemExit(0 if receipt['outcome']=='completed' else 1)

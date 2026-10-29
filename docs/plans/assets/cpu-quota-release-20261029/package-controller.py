import hashlib, json, os, signal, subprocess, time
from pathlib import Path

REPO=Path('/home/reoiv/dev/hetchy/tools/gmax/.claude/worktrees/gmax-cpu-quota-release-026105')
STATE=Path('/home/reoiv/.local/state/gmax-delivery/20261029-0.26.105')
GIB=1024**3

def memory():
    values={line.split(':')[0]:int(line.split(':')[1].split()[0])*1024 for line in Path('/proc/meminfo').read_text().splitlines()}
    return values['MemAvailable'],values['SwapTotal']-values['SwapFree']
def owned(pgid):
    output=subprocess.check_output(['/bin/ps','-eo','pid=,pgid=,rss=,stat='],text=True,timeout=2)
    return [(int(pid),int(rss)*1024) for line in output.splitlines() for pid,group,rss,status in [line.split()] if int(group)==pgid and not status.startswith('Z')]
def bound():
    os.sched_setaffinity(0,sorted(os.sched_getaffinity(0))[:2]); os.nice(10)

available,initial_swap=memory()
if available < 8*GIB: raise RuntimeError('Host memory admission refused')
commands=[
 ['node','scripts/prepare-lance-runtime.cjs'],
 ['node_modules/.bin/tsc','--incremental','false'],
 ['chmod','+x','dist/bin.js','dist/index.js'],
 ['node','scripts/prepare-bounded-runtime.cjs','/home/reoiv/.local/state/gmax-delivery/20261028-0.26.104/native','dist/vendor/maintenance','--required'],
 ['npm','pack','--ignore-scripts','--json','--pack-destination',str(STATE)],
]
env=os.environ.copy();env.update(GMAX_NO_AUTOSTART='1',NODE_OPTIONS='--max-old-space-size=768',MALLOC_ARENA_MAX='2')
receipt={'outcome':'incomplete','testsInvoked':0,'phases':[],'limits':{'deadlineSeconds':180,'maxOwnedRssBytes':2*GIB,'minAvailableBytes':8*GIB,'maxSwapGrowthBytes':0,'cpus':sorted(os.sched_getaffinity(0))[:2]}}
started=time.monotonic(); peak=0;child=None
try:
    for index,command in enumerate(commands):
        log_path=STATE/('pack.json' if command[0]=='npm' else f'package-phase-{index}.log')
        print(json.dumps({'phase':index,'command':command,'log':str(log_path)}),flush=True)
        with log_path.open('w') as log:
            child=subprocess.Popen(command,cwd=REPO,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=bound)
            while child.poll() is None:
                peak=max(peak,sum(rss for _,rss in owned(child.pid)))
                available,swap=memory()
                if time.monotonic()-started > 180 or peak > 2*GIB or available<8*GIB or swap-initial_swap>0:
                    raise RuntimeError('Local package resource/deadline guard refused continuation')
                time.sleep(.25)
            receipt['phases'].append({'command':command,'exitCode':child.returncode,'log':str(log_path),'noLiveOwnedProcesses':not owned(child.pid)})
            if child.returncode: raise RuntimeError('Local package phase failed: '+str(index))
            if owned(child.pid): raise RuntimeError('Local package descendant retained')
    receipt['outcome']='passed'
except BaseException as error:
    receipt['error']=str(error);receipt['outcome']='failed'
finally:
    if child is not None:
        if owned(child.pid):
            os.killpg(child.pid,signal.SIGTERM);time.sleep(.5)
            if owned(child.pid):os.killpg(child.pid,signal.SIGKILL)
        child.wait(timeout=3)
        receipt['noLiveOwnedProcesses']=not owned(child.pid)
    available,swap=memory()
    receipt['finalAvailableBytes']=available;receipt['finalSwapGrowthBytes']=max(0,swap-initial_swap)
    if available<8*GIB or swap>initial_swap:
        receipt['outcome']='failed';receipt['error']='Final host resource guard refused continuation'
    receipt['elapsedSeconds']=time.monotonic()-started;receipt['peakSampledOwnedRssBytes']=peak
    (STATE/'package-controller-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2),flush=True)
raise SystemExit(0 if receipt['outcome']=='passed' else 1)

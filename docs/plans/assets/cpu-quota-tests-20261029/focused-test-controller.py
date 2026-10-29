import hashlib,json,os,shutil,signal,subprocess,tempfile,time
from pathlib import Path
repo=Path('/home/reoiv/dev/hetchy/tools/gmax')
state=Path('/home/reoiv/.local/state/gmax-cpu-quota-tests/20261029T002307Z')
node=shutil.which('node');assert node
commands=[('focused-tests',[node,'--max-old-space-size=768','node_modules/vitest/vitest.mjs','run','--config',str(state/'focused-vitest.config.mjs'),'--reporter=json','--outputFile='+str(state/'focused-tests-results.json')])]
def memory():
 v={s.split(':')[0]:int(s.split(':')[1].split()[0])*1024 for s in Path('/proc/meminfo').read_text().splitlines()}
 return v['MemAvailable'],v['SwapTotal']-v['SwapFree']
def group(pgid):
 output=subprocess.check_output(['/bin/ps','-eo','pid=,pgid=,rss=,stat='],text=True,timeout=2)
 return [(int(pid),int(rss)*1024) for s in output.splitlines() for pid,gid,rss,status in [s.split()] if int(gid)==pgid and not status.startswith('Z')]
def bound():
 os.sched_setaffinity(0,sorted(os.sched_getaffinity(0))[:2]);os.nice(10)
started=time.monotonic();available,swap0=memory();receipt={'kind':'focused-cpu-quota-global-file-admission-regressions','testInvocations':1,'commands':[],'limits':{'deadlineSeconds':120,'ownedRssBytes':2*1024**3,'minimumAvailableBytes':8*1024**3,'swapGrowthBytes':512*1024**2,'cpuAffinity':sorted(os.sched_getaffinity(0))[:2]}}
test_home=tempfile.TemporaryDirectory(prefix='gmax-cpu-quota-tests-')
env=dict(os.environ,HOME=test_home.name,GMAX_HOME=str(Path(test_home.name)/'.gmax'),NODE_OPTIONS='--max-old-space-size=768')
child=None;peak=0;swap_peak=0;minimum=available
try:
 if available<8*1024**3:raise RuntimeError('host-available-memory')
 for label,command in commands:
  entry={'label':label,'argv':command};receipt['commands'].append(entry)
  with (state/(label+'.log')).open('w') as log:
   child=subprocess.Popen(command,cwd=repo,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=bound,env=env)
   while child.poll() is None:
    peak=max(peak,sum(rss for _,rss in group(child.pid)));available,swap=memory();minimum=min(minimum,available);swap_peak=max(swap_peak,swap-swap0)
    if time.monotonic()-started>120:raise RuntimeError('deadline')
    if peak>2*1024**3:raise RuntimeError('owned-rss')
    if available<8*1024**3:raise RuntimeError('host-available-memory')
    if swap-swap0>512*1024**2:raise RuntimeError('host-swap-growth')
    time.sleep(.2)
   entry['exitCode']=child.returncode
   if child.returncode:raise RuntimeError('check-failed:'+label)
 receipt['outcome']='passed'
except BaseException as error:
 receipt['outcome']='failed';receipt['error']=str(error)
finally:
 if child is not None:
  if group(child.pid):
   os.killpg(child.pid,signal.SIGTERM);time.sleep(.25)
   if group(child.pid):os.killpg(child.pid,signal.SIGKILL)
  child.wait(timeout=3)
 receipt.update(elapsedSeconds=time.monotonic()-started,peakOwnedRssBytes=peak,maximumSwapGrowthBytes=swap_peak,minimumAvailableBytes=minimum,noLiveOwnedProcesses=(child is None or not group(child.pid)),sourceHashes={name:hashlib.sha256((repo/name).read_bytes()).hexdigest() for name in ['src/config.ts', 'src/commands/config.ts', 'src/lib/utils/cpu-capacity.ts', 'src/lib/workers/pool.ts', 'tests/setup.ts', 'tests/cpu-capacity.test.ts', 'tests/worker-threads-setting.test.ts', 'tests/config-command.test.ts', 'tests/worker-pool-resilience.test.ts']})
 test_home.cleanup()
 receipt['temporaryHomeRemoved']=not Path(test_home.name).exists()
 (state/'focused-tests.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt,indent=2))
raise SystemExit(0 if receipt['outcome']=='passed' else 1)

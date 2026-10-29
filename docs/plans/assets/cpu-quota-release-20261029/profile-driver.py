"""One approved, bounded live-service search profile. No model/store writes."""
import hashlib,json,math,os,socket,subprocess,sys,time
from pathlib import Path
STATE=Path('/home/reoiv/.local/state/gmax-profile/20261029T010000Z-0.26.105-production-search')
HOME_DIR=Path('/home/reoiv/.gmax');PROJECT='/home/reoiv/dev/hetchy/platform'
CGROUP=Path('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/hetchy-gmax.service')
HZ=os.sysconf('SC_CLK_TCK');ROUNDS=4
QUERIES=[('cache','Where are cached values invalidated when a file changes?'),('worker','How does the worker pool dispatch queued tasks?'),('lease','How is an exclusive lease acquired and released?'),('timeout','Where are request deadlines enforced and aborted?'),('fts','Where are full text search indexes created and queried?'),('socket','How are local socket permissions checked at startup?')]
report={'outcome':'incomplete','startedAt':time.time(),'projectRoot':PROJECT,'rounds':ROUNDS,'queries':len(QUERIES),'requestedSamples':48,'warmups':[],'samples':[],'roundStatus':[],'rpcCalls':{},'metadata':{}}

def rpc(command,timeout=20):
    assert command['cmd'] in ('ping','status','search')
    report['rpcCalls'][command['cmd']]=report['rpcCalls'].get(command['cmd'],0)+1
    started=time.perf_counter()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout);conn.connect(str(HOME_DIR/'daemon.sock'))
        conn.sendall((json.dumps(command)+'\n').encode());chunks=bytearray()
        while b'\n' not in chunks:
            block=conn.recv(65536)
            if not block:raise RuntimeError('IPC closed before response')
            chunks.extend(block)
            if len(chunks)>2*1024**2:raise RuntimeError('Profile response cap exceeded')
        response=json.loads(chunks.split(b'\n',1)[0])
    elapsed=(time.perf_counter()-started)*1000
    if response.get('ok') is not True:raise RuntimeError('IPC refused: '+str(response.get('code',response.get('error','unknown')))[:100])
    return response,elapsed

def proc(pid,main=False):
    path=Path(f'/proc/{pid}/task/{pid}/stat' if main else f'/proc/{pid}/stat')
    fields=path.read_text().rsplit(')',1)[1].split()
    return {'start':fields[19],'ticks':int(fields[11])+int(fields[12])}

def snapshot():
    cpu={k:int(v) for k,v in (line.split() for line in (CGROUP/'cpu.stat').read_text().splitlines())}
    procs={}
    for text in (CGROUP/'cgroup.procs').read_text().split():
        try:procs[int(text)]=proc(int(text))
        except FileNotFoundError:pass
    return {'cpu':cpu,'processes':procs,'main':proc(report['daemonPid'],True),'at':time.perf_counter()}

def diff(before,after):
    total=(after['cpu']['usage_usec']-before['cpu']['usage_usec'])/1000
    if total<0:raise RuntimeError('Service CPU counters reset')
    daemon=report['daemonPid'];a=after['processes'];b=before['processes']
    def delta(pid):
        if pid not in a:return 0
        if pid in b and a[pid]['start']==b[pid]['start']:return (a[pid]['ticks']-b[pid]['ticks'])*1000/HZ
        return 0
    daemon_cpu=delta(daemon)
    main_cpu=(after['main']['ticks']-before['main']['ticks'])*1000/HZ
    return {'serviceCpuMs':total,'daemonCpuMs':daemon_cpu,'daemonMainThreadCpuMs':main_cpu,'daemonOtherThreadCpuMs':max(0,daemon_cpu-main_cpu),'workerCpuMs':sum(delta(pid) for pid in a if pid!=daemon),'processSetStable':set(a)==set(b),'workers':len(a)-1,'throttledMs':(after['cpu'].get('throttled_usec',0)-before['cpu'].get('throttled_usec',0))/1000,'cpuPeriods':after['cpu'].get('nr_periods',0)-before['cpu'].get('nr_periods',0),'throttledPeriods':after['cpu'].get('nr_throttled',0)-before['cpu'].get('nr_throttled',0)}

def status():
    response,_=rpc({'cmd':'status'},5)
    projects=response.get('projects',[]);project=next((p for p in projects if p.get('root')==PROJECT),{})
    index=project.get('indexState',{});queue=project.get('queue') or index.get('queue') or {}
    return {'at':time.time(),'workers':response.get('workers'),'serviceMode':response.get('service',{}).get('mode'),'projectStatus':project.get('status'),'indexing':index.get('indexing'),'pendingFiles':index.get('pendingFiles'),'activeFiles':queue.get('activeFiles'),'lastResourceSnapshot':response.get('resources')}

def background(label):
    before=snapshot();time.sleep(2);after=snapshot()
    return {'label':label,'wallMs':(after['at']-before['at'])*1000,**diff(before,after)}

def search(query,rerank,diagnostics):
    return rpc({'cmd':'search','projectRoot':PROJECT,'pathPrefix':PROJECT,'query':query,'limit':10,'rerank':rerank,'diagnostics':diagnostics})

def percentile(values,p):
    values=sorted(values);return values[max(0,math.ceil(len(values)*p)-1)]

started=time.perf_counter()
try:
    ping,_=rpc({'cmd':'ping'},3)
    assert ping['version']=='0.26.105' and ping['ready'] and ping['operationStatus']=='open' and ping['service']['mode']=='active'
    report['daemonPid']=ping['pid'];report['version']=ping['version'];report['beforeStatus']=status()
    assert report['beforeStatus']['workers']>=1
    report['metadata']['before']={'outcome':'omitted','reason':'Optional native metadata helper excluded by ratified scope'}
    report['backgroundBefore']=background('before warmup')
    print(json.dumps({'phase':'profile-started','pid':ping['pid'],'workers':report['beforeStatus']['workers'],'pendingFiles':report['beforeStatus']['pendingFiles'],'metadata':report['metadata']['before']}),flush=True)
    for label,query in QUERIES:
        for rerank in (False,True):
            result,elapsed=search(query,rerank,True)
            diagnostics=result.get('diagnostics',{})
            if diagnostics.get('fts',{}).get('available') is not True or diagnostics.get('fts',{}).get('searchFailed'):
                raise RuntimeError('FTS unavailable during warmup')
            if rerank and diagnostics.get('gate',{}).get('rerankInvoked') is not True:raise RuntimeError('Requested rerank was not invoked')
            report['warmups'].append({'query':label,'rerank':rerank,'elapsedMs':elapsed,'results':len(result.get('data',[])),'stages':diagnostics.get('stages'),'gate':diagnostics.get('gate'),'fts':diagnostics.get('fts'),'settings':diagnostics.get('settings')})
            (STATE/'partial-results.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps({'phase':'warmup-completed','query':label,'rerank':rerank,'elapsedMs':round(elapsed,3)}),flush=True)
    for round_number in range(ROUNDS):
        report['roundStatus'].append(status())
        for index in range(len(QUERIES)):
            label,query=QUERIES[(index+round_number)%len(QUERIES)]
            order=(False,True) if (index+round_number)%2==0 else (True,False)
            for rerank in order:
                before=snapshot();response,elapsed=search(query,rerank,False);after=snapshot()
                data=response.get('data',[])
                sample={'round':round_number,'query':label,'rerank':rerank,'elapsedMs':elapsed,'results':len(data),'responseBytes':len(json.dumps(response,separators=(',',':')).encode()),'responseDigest':hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'warnings':len(response.get('warnings',[])),**diff(before,after)}
                report['samples'].append(sample)
                (STATE/'partial-results.json').write_text(json.dumps(report,indent=2)+'\n')
                print(json.dumps({'phase':'sample','count':len(report['samples']),'query':label,'rerank':rerank,'elapsedMs':round(elapsed,3),'serviceCpuMs':round(sample['serviceCpuMs'],3)}),flush=True)
        (STATE/'partial-results.json').write_text(json.dumps(report,indent=2)+'\n')
    report['backgroundAfter']=background('after measured requests')
    report['afterStatus']=status()
    final,_=rpc({'cmd':'ping'},3);assert final['pid']==report['daemonPid'] and final['version']==report['version'] and final['ready'] and final['operationStatus']=='open'
    assert len(report['samples'])==48
    report['outcome']='completed'
except BaseException as error:
    report['outcome']='partial' if report['samples'] else 'failed';report['errorType']=type(error).__name__;report['error']=str(error)[:200]
finally:
    report['elapsedSeconds']=time.perf_counter()-started
    report['summaries']={}
    for rerank in (False,True):
        rows=[s for s in report['samples'] if s['rerank']==rerank]
        if not rows:continue
        summary={'samples':len(rows)}
        for key in ['elapsedMs','serviceCpuMs','daemonCpuMs','daemonMainThreadCpuMs','daemonOtherThreadCpuMs','workerCpuMs','throttledMs']:
            values=[row[key] for row in rows];summary[key]={'p50':percentile(values,.5),'p95':percentile(values,.95),'mean':sum(values)/len(values),'max':max(values)}
        summary['throttledPeriods']=sum(s['throttledPeriods'] for s in rows);summary['cpuPeriods']=sum(s['cpuPeriods'] for s in rows);summary['processSetStableSamples']=sum(s['processSetStable'] for s in rows)
        summary['warnings']=sum(s['warnings'] for s in rows)
        report['summaries']['reranked' if rerank else 'default']=summary
    report['scope']='Serial warm IPC searches through existing public0.26.105 service over the registered live platform corpus; fixed six engineering queries, default versus explicit rerank, four alternating rounds. No model/store/index/service configuration changes by this profiler.'
    report['limitations']=['Live background indexing and concurrent writers remain enabled; service CPU, thread CPU and memory include background work. These are not isolated query CPU measurements.','Per-process/thread CPU uses scheduler ticks; cgroup CPU uses microseconds. CPU splits are execution buckets, not internal search-stage timers.','Kernel sampling is unavailable under current perf policy; existing search diagnostics expose candidate counts and rerank decisions, not phase times.','Optional native/table metadata snapshots were omitted. Response digest changes can reflect normal writes.','Small warm shared-host sample, no cold-start, SLO, relevance, prior-version comparison or measured FTS speedup claim.','Raw result content, vectors, paths and candidate traces are discarded; only numeric metrics and response digests are retained.']
    (STATE/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'outcome':report['outcome'],'samples':len(report['samples']),'elapsedSeconds':report['elapsedSeconds'],'summaries':report['summaries'],'error':report.get('error')}),flush=True)
raise SystemExit(0 if report['outcome']=='completed' else 1)

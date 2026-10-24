#!/usr/bin/env node
'use strict';
// Four disposable single-worker indexing arms. No daemon, listener or live store.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { transformSync } = Module.createRequire(require.resolve('tsx/package.json'))('esbuild');
const REPO = path.resolve(__dirname, '../..');
const REF = 'v0.26.96';
const BUNDLE = path.join(REPO, 'docs/measurements/colbert-backend-wave1-20261023/bundle-v4');
const need = (v, message) => { if (!v) throw new Error(message); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const git = args => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 8*1024*1024 });
function releaseLoader() {
  const files = new Set(git(['ls-tree', '-r', '--name-only', REF]).trim().split('\n'));
  const cache = new Map(), hashes = {};
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const code = git(['show', `${REF}:${name}`]); hashes[name] = sha(code);
    if (name.endsWith('.json')) { const value={exports:JSON.parse(code)};cache.set(name,value);return value.exports; }
    const filename = path.join(REPO, name), m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename)); cache.set(name, m);
    const original = m.require.bind(m);
    m.require = specifier => {
      if (specifier.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        const candidate = [base, base+'.ts', base+'/index.ts', base.replace(/\.js$/, '.ts')].find(p => files.has(p));
        need(candidate, 'Unresolved released relative module: '+name+' '+specifier);
        return load(candidate);
      }
      return original(specifier);
    };
    m._compile(transformSync(code, { loader: 'ts', format: 'cjs', target: 'node22' }).code, filename);
    return m.exports;
  }
  return { load, hashes };
}
function cloneTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const a=path.join(source,entry.name),b=path.join(destination,entry.name);
    if (entry.isDirectory()) cloneTree(a,b);
    else if (entry.isFile()) fs.copyFileSync(a,b,fs.constants.COPYFILE_FICLONE);
    else throw new Error('Nonregular runtime artifact');
  }
}
function inventoryFiles(directory) {
  const files=[];
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const p=path.join(directory,entry.name);
    if (entry.isDirectory()) files.push(...inventoryFiles(p));
    else if (entry.isFile()) files.push({file:p,bytes:fs.statSync(p).size,sha256:sha(fs.readFileSync(p))});
    else throw new Error('Nonregular artifact');
  }
  return files;
}
async function mpsBridge(root) {
  const child = spawn(path.join(root,'venv/bin/python'),['-I','-B',path.join(__dirname,'index-mps.py'),root],{stdio:['pipe','pipe','inherit']});
  const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
  const iterator=lines[Symbol.asyncIterator]();
  let exitCode;
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{exitCode=code;resolve({code,signal});});});
  async function receive() {
    const item=await iterator.next();need(!item.done && item.value.length<=3*1024*1024,'Missing/oversized MPS response');
    const result=JSON.parse(item.value);need(result.ok,'MPS refused');return result;
  }
  need((await receive()).ready,'MPS failed readiness');
  return { async run(feeds) {
    child.stdin.write(JSON.stringify({shape:feeds.input_ids.dims,ids:Array.from(feeds.input_ids.data,Number),mask:Array.from(feeds.attention_mask.data,Number)})+'\n');
    const result=await receive(),bytes=Buffer.from(result.data,'base64');
    need(bytes.length===result.shape.reduce((a,b)=>a*b,1)*4,'MPS wire shape mismatch');
    const data=new Float32Array(bytes.length/4);for(let i=0;i<data.length;i++)data[i]=bytes.readFloatLE(i*4);
    need(data.every(Number.isFinite),'Nonfinite MPS wire vectors');
    return data;
  }, async close() {
    if (exitCode===undefined) {child.stdin.end('{"command":"close"}\n');const status=await exited;need(status.code===0&&!status.signal,'MPS cleanup failed');}
    lines.close();
  }};
}
async function run(root) {
  need(process.env.HOME && process.env.GMAX_HOME && fs.realpathSync(process.cwd()).startsWith('/private/tmp/gmax-colbert-wave1-'),'Owned private working directory required');
  // ps lstart is timezone-formatted. Match the host's normal timezone rather
  // than the controller's UTC reporting environment before reading host records.
  delete process.env.TZ;
  const sourceRoot=path.join(BUNDLE,'sources/gmax');
  const manifest=json(path.join(BUNDLE,'sources.json')),corpus=manifest.corpora.find(c=>c.id==='gmax');
  need(corpus && corpus.files.filter(f=>f.role==='candidate').length===81,'Frozen Gmax workload changed');
  for(const f of corpus.files)need(sha(fs.readFileSync(path.join(sourceRoot,f.path)))===f.sha256,'Frozen source changed');
  const inputProof={sourceManifestSha256:sha(fs.readFileSync(path.join(BUNDLE,'sources.json'))),snapshotRevision:corpus.revision,files:corpus.files};
  const privateModels=path.join(os.homedir(),'.gmax/models');
  // Prepared clones only: model loading never reaches the user's installed directories.
  cloneTree(path.join(root,'index-models'),privateModels);
  cloneTree(path.join(root,'index-grammars'),path.join(os.homedir(),'.gmax/grammars'));
  const artifacts=inventoryFiles(privateModels),grammars=inventoryFiles(path.join(os.homedir(),'.gmax/grammars'));
  const snapshot=releaseLoader();
  const {WorkerOrchestrator}=snapshot.load('src/lib/workers/orchestrator.ts');
  const {VectorDB}=snapshot.load('src/lib/store/vector-db.ts');
  const {MetaCache}=snapshot.load('src/lib/store/meta-cache.ts');
  const {ProjectFilePolicy}=snapshot.load('src/lib/index/file-policy.ts');
  const {resolveEmbeddingGeneration}=snapshot.load('src/lib/index/embedding-generation.ts');
  const hf=require('@huggingface/transformers');hf.env.allowRemoteModels=false;
  global.fetch=async()=>{throw new Error('Network disabled for disposable indexing comparison');};
  const generation=resolveEmbeddingGeneration({modelTier:'small'});
  // Store selection is private; resource admission remains machine-wide.
  const hostSharedRoot=json(path.join(root,'index-host.json')).sharedRoot;
  const budget=snapshot.load('src/lib/utils/resource-budget.ts').resourceBudget;
  const safetyReason=snapshot.load('src/lib/utils/safety-latch.ts').safetyStopReason;
  require('./index-admission.cjs').installIndexAdmission(budget,hostSharedRoot,safetyReason);
  const worker=new WorkerOrchestrator(generation,'cpu');
  await worker.ensureReady();await worker.granite.load();
  need(worker.chunker.parser && worker.skeletonizer,'Native parser unavailable');
  const cpuSession=worker.colbert.session;
  const bridge=await mpsBridge(root);
  const mpsSession={outputNames:cpuSession.outputNames,async run(feeds){const data=await bridge.run(feeds);return {[cpuSession.outputNames[0]]:{data,dims:[...feeds.input_ids.dims,48]}};}};
  let phases;
  try {
    async function phase(backend,name,warmup=false) {
      console.error(`${warmup?'Warming':'Indexing'} ${name}`);
      worker.colbert.session=backend==='mps'?mpsSession:cpuSession;
      const timings={denseMs:0,colbertMs:0,storeMs:0,processFileMs:0};
      const denseRun=worker.granite.runBatch.bind(worker.granite),colbertRun=worker.colbert.runBatch.bind(worker.colbert);
      worker.granite.runBatch=async(...args)=>{const t=performance.now();try{return await denseRun(...args);}finally{timings.denseMs+=performance.now()-t;}};
      worker.colbert.runBatch=async(...args)=>{const t=performance.now();try{return await colbertRun(...args);}finally{timings.colbertMs+=performance.now()-t;}};
      const denseHash=crypto.createHash('sha256'),structuralHash=crypto.createHash('sha256');
      const cpuStarted=process.cpuUsage(),started=performance.now();
      const directory=path.resolve(name);fs.mkdirSync(directory);
      const db=new VectorDB(path.join(directory,'lance'),384),meta=new MetaCache(path.join(directory,'meta.lmdb'));
      const policy=new ProjectFilePolicy(sourceRoot);
      let files=0,chunks=0,skipped=0;
      try {
        const discovered=inventoryFiles(sourceRoot).map(f=>path.relative(sourceRoot,f.file));
        const candidates=corpus.files.filter(f=>f.role==='candidate').map(f=>f.path).sort();
        need(candidates.every(f=>discovered.includes(f)),'Discovery missed source');
        for(const relative of candidates) {
          const absolute=path.join(sourceRoot,relative),state=await policy.classifyFile(absolute);
          if(state.status!=='indexable'){skipped++;continue;}
          const t=performance.now();const result=await worker.processFile({path:absolute,projectRoot:sourceRoot});timings.processFileMs+=performance.now()-t;
          for(const vector of result.vectors) {
            need(vector.vector.length===384 && vector.colbert.length>0 && vector.doc_token_ids.length*48===vector.colbert.length,'Invalid record shape');
            denseHash.update(Buffer.from(vector.vector.buffer,vector.vector.byteOffset,vector.vector.byteLength));
            structuralHash.update(JSON.stringify([relative,vector.hash,vector.chunk_index,vector.start_line,vector.end_line,sha(vector.content)]));
          }
          const storeStarted=performance.now();await db.insertBatch(result.vectors);
          meta.put(absolute,{hash:result.hash,mtimeMs:result.mtimeMs,size:result.size,hashVersion:1,hasVectors:result.vectors.length>0});
          timings.storeMs+=performance.now()-storeStarted;
          files++;chunks+=result.vectors.length;
        }
      } finally {
        await meta.close();await db.close();worker.granite.runBatch=denseRun;worker.colbert.runBatch=colbertRun;
      }
      const seconds=(performance.now()-started)/1000,cpu=process.cpuUsage(cpuStarted);
      const verify=new VectorDB(path.join(directory,'lance'),384);
      let persisted;
      try {persisted=await verify.countRowsForPath(sourceRoot);}finally{await verify.close();}
      need(persisted===chunks,'Persisted row count mismatch');
      const result={backend,name,warmup,seconds,cpuUserSeconds:cpu.user/1e6,cpuSystemSeconds:cpu.system/1e6,files,chunks,skipped,persisted,denseSha256:denseHash.digest('hex'),structureSha256:structuralHash.digest('hex'),timings};
      fs.writeFileSync(path.join(directory,'phase.json'),JSON.stringify(result,null,2)+'\n');
      return result;
    }
    // Full untimed passes warm every encountered batch/sequence shape and native-store path.
    const warmups=[await phase('onnx-cpu','warm-onnx',true),await phase('mps','warm-mps',true)];
    phases=[];
    for(const [pass,order]of [[1,['onnx-cpu','mps']],[2,['mps','onnx-cpu']]])for(const backend of order)phases.push({...await phase(backend,`pass${pass}-${backend}`),pass});
    need([...warmups,...phases].every(p=>p.denseSha256===phases[0].denseSha256 && p.structureSha256===phases[0].structureSha256 && p.chunks===phases[0].chunks),'Compared arms changed dense vectors or chunk identities');
    const ratios=[1,2].map(pass=>{const a=phases.find(p=>p.pass===pass&&p.backend==='onnx-cpu'),b=phases.find(p=>p.pass===pass&&p.backend==='mps');return {pass,ratio:a.seconds/b.seconds,onnxSeconds:a.seconds,mpsSeconds:b.seconds};});
    const report={ok:true,inferencePerformed:true,productionChanged:false,sourceRef:REF,sourceCommit:git(['rev-parse',REF+'^{commit}']).trim(),sourceHashes:snapshot.hashes,inputProof,artifacts,grammars,generation,warmups,phases,ratios,
      resourceAdmission:{sharedLedger:path.join(hostSharedRoot,'resource-budget'),clientRegistrationRequired:budget.deps.requireClientRegistration,hostQuarantineChecked:true,criticalLatchDestination:'private experiment home'},
      runtimes:{ort:require('onnxruntime-node/package.json').version,lance:JSON.parse(fs.readFileSync(path.join(REPO,'node_modules/@lancedb/lancedb/package.json'))).version},
      scope:'Warm one-worker initial indexing over the frozen Gmax subset: actual discovery/policy/read/chunk/skeleton, fresh Granite-small q4 ONNX CPU dense vectors, ColBERT ONNX-int8 CPU versus original-FP32 MPS over owned JSON/base64 IPC, actual native LanceDB inserts and LMDB metadata flush/close. Both arms use released v0.26.96 worker/store code. Verification reads excluded from timers.',
      limits:'Not multi-worker daemon/watch/incremental scheduling or MLX dense. Full untimed warmups precede opposite-order timed passes. Process CPU excludes MPS child CPU; parent group snapshots include it. No production setting or model identity change.'};
    fs.writeFileSync('index-result.json',JSON.stringify(report,null,2)+'\n');
    return {ok:true,inferencePerformed:true,modelConstructed:true,resultPath:path.resolve('index-result.json'),ratios,files:phases[0].files,chunks:phases[0].chunks};
  } finally {await bridge.close();await cpuSession.release();await worker.granite.session.release();}
}
async function main() {
  const [mode,rootArg]=process.argv.slice(2);need(['--execute','--child'].includes(mode)&&rootArg&&process.argv.length===4,'Expected --execute /absolute/prepared-root');const root=fs.realpathSync(rootArg);
  if(mode==='--child'){const result=await run(root);process.stdout.write(JSON.stringify(result)+'\n');return;}
  const {runMacSmoke}=require('./runner.cjs'),controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{const result=await runMacSmoke(root,{execute:true,indexScreen:true,signal:controller.signal});console.log(JSON.stringify({ok:result.ok,code:result.code,response:result.response,evaluationRoot:result.evaluationRoot,manifestPath:result.manifestPath}));if(!result.ok)process.exitCode=1;}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

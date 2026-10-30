import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
// Fixed trusted bridge. Runs only inside the local operational guard.
import { readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
const controller = new AbortController();
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.includes('cancel')) controller.abort(new Error('P3 caller cancelled')); });
process.on('SIGTERM', () => controller.abort(new Error('P3 guard stopping')));
try {
  if (!input || !output || statSync(input).size > 2*1024*1024) throw new Error('Invalid bounded sender input');
  const { request, config } = JSON.parse(readFileSync(input, 'utf8'));
  const root = resolve(config.runtimeCheckout);
  const platform = [resolve(root, '../platform'), resolve(root, '../../platform')].find(p => existsSync(join(p, 'scripts/gmax-worker.mjs')));
  if (!platform) throw new Error('Adjacent fixed Worker bridge absent');
  const { dispatchGmaxJob, GMAX_SSH_LIFETIME } = await import(pathToFileURL(join(platform, 'scripts/gmax-worker.mjs')).href);
  if (GMAX_SSH_LIFETIME !== 'operation') throw new Error('Fixed Worker bridge lacks operation-owned SSH lifetime');
  const {captureGmaxSource, checkGmaxSource} = await import(pathToFileURL(join(platform,'scripts/lib/gmax-project.mjs')).href);
  const cache = join(process.env.GMAX_HOME || join(homedir(),'.gmax'),'remote-embedding-source');
  mkdirSync(cache,{recursive:true,mode:0o700});
  const capture = (sourceRoot, ref) => {
    if(ref !== config.runtimeCommit || !/^[a-f0-9]{40}$/.test(ref)) throw new Error('Sender source revision differs');
    const key=createHash('sha256').update(sourceRoot+'\0'+ref).digest('hex');
    const packet=join(cache,key+'.packet'), meta=join(cache,key+'.json');
    if(existsSync(packet) && existsSync(meta)) {
      if(statSync(packet).size>64*1024*1024 || statSync(meta).size>4096) throw new Error('Cached source exceeds bound');
      const source=readFileSync(packet), record=JSON.parse(readFileSync(meta,'utf8'));
      if(record.commit!==ref || createHash('sha256').update(source).digest('hex')!==record.sourceSha256) throw new Error('Cached source identity differs');
      checkGmaxSource(source,record);
      return {...record,source};
    }
    const frozen=captureGmaxSource(sourceRoot,ref);
    writeFileSync(packet,frozen.source,{flag:'wx',mode:0o600});
    writeFileSync(meta,JSON.stringify({commit:frozen.commit,sourceSha256:frozen.sourceSha256}),{flag:'wx',mode:0o600});
    return frozen;
  };
  const onIdentity = identity => {
    if(identity.jobId!==request.jobId || !/^[a-f0-9]{32}$/.test(identity.remoteJobId)) throw new Error('Admitted job identity differs');
    const final=join(dirname(output),'identity.json'), temp=final+'.partial';
    writeFileSync(temp,JSON.stringify(identity),{flag:'wx',mode:0o600}); renameSync(temp,final);
  };
  const reply = await dispatchGmaxJob({ task:'embed-batch', worker:config.worker, sourceRoot:root, ref:config.runtimeCommit, timeoutS:180, embedding:request }, { signal:controller.signal, capture, onIdentity });
  // Retain bounded terminal/artifact provenance after raw vectors are removed.
  // This is evidence from the actual dispatch, never another worker request.
  writeFileSync(join(dirname(output),'terminal.json'), JSON.stringify({
    state:reply.state,exitCode:reply.exitCode,jobId:reply.jobId,
    remoteJobId:reply.remoteJobId,remoteTaskId:reply.remoteTaskId,
    terminal:reply.terminal,cleanupConfirmed:reply.cleanupConfirmed,
    resultPath:reply.resultPath,transportLog:reply.transportLog,artifacts:reply.artifacts,
    nativeObservation:reply.nativeObservation,
  }), {flag:'wx',mode:0o600});
  const bytes = JSON.stringify(reply);
  if (Buffer.byteLength(bytes) > 13*1024*1024) throw new Error('Sender result exceeds bound');
  writeFileSync(output, bytes, { flag:'wx', mode:0o600 });
} catch (error) {
  // No terminal cleanup can be inferred from sender failure.
  writeFileSync(output, JSON.stringify({ terminal:false, cleanupConfirmed:false, reason:error instanceof Error ? error.message : 'sender failed' }), { flag:'wx', mode:0o600 });
} finally { process.stdin.destroy(); }

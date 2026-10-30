#!/usr/bin/env node
// Exact offline model bytes for the selected Dell preparation, never inference.
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const [commit, receipt] = process.argv.slice(2);
try {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !receipt) throw Error('Use <full-runtime-commit> <new-receipt>');
  const started = Date.now(), left = () => { const ms = 170000-(Date.now()-started); if(ms<=0)throw Error('Asset staging deadline reached'); return ms; };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), platform = resolve(root, '../../platform');
  const {readRoster,operationSshWorker,sshOpts,networkPolicyAdmission}=await import(pathToFileURL(join(platform,'scripts/worker-pool.mjs')).href);
  const {windowsPowerShell,windowsResult}=await import(pathToFileURL(join(platform,'scripts/lib/worker-windows.mjs')).href);
  const worker=operationSshWorker(readRoster().workers.find(w=>w.name==='dell-win'));
  const policy=networkPolicyAdmission(worker);if(!policy.ok)throw Error(policy.detail);
  const opts=sshOpts(worker), modelRoot=join(homedir(),'.gmax/models');
  const generation={tier:'small',vectorDim:384,onnxModel:'onnx-community/granite-embedding-small-english-r2-ONNX',mlxModel:'ibm-granite/granite-embedding-small-english-r2',colbertModel:'ryandono/mxbai-edge-colbert-v0-17m-onnx-int8'};
  generation.fingerprint=createHash('sha256').update(JSON.stringify(['gmax-embedding-generation-v1',generation.tier,generation.vectorDim,generation.onnxModel,generation.mlxModel,generation.colbertModel])).digest('hex');
  const names=[...['config.json','tokenizer.json','tokenizer_config.json','onnx/model_q4.onnx','onnx/model_q4.onnx_data'].map(p=>generation.onnxModel+'/'+p),...['config.json','tokenizer.json','tokenizer_config.json','skiplist.json','onnx/model_int8.onnx'].map(p=>generation.colbertModel+'/'+p)];
  const models=[];for(const path of names){const full=join(modelRoot,path),st=lstatSync(full);if(!st.isFile()||st.isSymbolicLink()||st.size>1024**3)throw Error('Invalid selected cached model');const hash=createHash('sha256');for await(const bytes of createReadStream(full))hash.update(bytes);const after=lstatSync(full);if(st.size!==after.size||st.mtimeMs!==after.mtimeMs)throw Error('Model changed while staging');models.push({path,bytes:st.size,sha256:hash.digest('hex')});}
  const spec={schemaVersion:1,commit,generation,generationFingerprint:generation.fingerprint,colbertDim:48,models};
  const local=receipt+'.input.json';writeFileSync(local,JSON.stringify(spec),{flag:'wx',mode:0o600});
  const remote=`C:/Users/<job-account>/gmax-cache/.embedding-assets/${commit}`;
  const dirs=[...new Set(models.map(f=>dirname(f.path).replaceAll('\\','/')))];
  const setup=`$base='${remote}'; if(Test-Path -LiteralPath $base){throw 'Owned asset stage already exists; reconcile before reuse'}; New-Item -ItemType Directory -Path $base -ErrorAction Stop | Out-Null; ${dirs.map(d=>`New-Item -ItemType Directory -Path (Join-Path $base 'models/${d}') -Force | Out-Null`).join('; ')}; [pscustomobject]@{base=$base;created=$true}|ConvertTo-Json -Compress`;
  const created=windowsResult(windowsPowerShell(worker,setup,{sshOpts:opts,timeoutMs:Math.min(left(),20000)}),'creating owned fixed asset stage');
  for(const file of [...models.map(f=>({from:join(modelRoot,f.path),to:'models/'+f.path})),{from:local,to:'input.json'}]){
    const r=spawnSync('scp',['-O',...opts,file.from,`${worker.target}:${remote}/${file.to}`],{encoding:'utf8',timeout:left(),maxBuffer:1024*1024});if(r.status!==0||r.error)throw Error('Selected model transfer failed: '+(r.error?.message??r.stderr).slice(-300));
  }
  const verify=`$base='${remote}';$m=Get-Content -LiteralPath (Join-Path $base 'input.json') -Raw|ConvertFrom-Json; foreach($f in $m.models){$p=Join-Path $base ('models/'+$f.path);if((Get-Item -LiteralPath $p).Length -ne $f.bytes -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne $f.sha256){throw 'Transferred asset digest differs'}};$sid=(Get-LocalUser -Name <job-account>).SID.Value;& icacls.exe $base /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-18:(OI)(CI)(F)' ('*'+$sid+':(OI)(CI)(RX)') /T /Q | Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned model stage ACL failed'};[pscustomobject]@{verified=$true;files=$m.models.Count;root=$base}|ConvertTo-Json -Compress`;
  const verified=windowsResult(windowsPowerShell(worker,verify,{sshOpts:opts,timeoutMs:left()}),'verifying exact staged model bytes');
  writeFileSync(receipt,JSON.stringify({state:'staged',created,verified,spec,elapsedMs:Date.now()-started},null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({state:'staged',files:models.length,bytes:models.reduce((n,f)=>n+f.bytes,0)}));
}catch(error){console.error(error.message);process.exitCode=75;}

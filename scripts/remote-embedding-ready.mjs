#!/usr/bin/env node
// Finalize only this explicitly selected immutable prepared cache; no model run.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [commit, receipt, readyId, originalManifest, repairFile] = process.argv.slice(2);
let expectedManifest=originalManifest;
const deadline = Date.now() + 170000;
try {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !receipt || existsSync(receipt) || !/^[a-f0-9]{32}$/.test(readyId ?? '') || !/^[a-f0-9]{64}$/.test(expectedManifest ?? '')) throw Error('Use <full-runtime-commit> <new-receipt>');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),platform=resolve(root,'../../platform');
  const {readRoster,operationSshWorker,sshOpts}=await import(pathToFileURL(join(platform,'scripts/worker-pool.mjs')).href);
  const {windowsPowerShell,windowsResult}=await import(pathToFileURL(join(platform,'scripts/lib/worker-windows.mjs')).href);
  const worker=operationSshWorker(readRoster().workers.find(w=>w.name==='dell-win'));
  const {emitGmaxEmbeddingVerification}=await import(pathToFileURL(join(platform,'scripts/lib/gmax-embedding-verify.mjs')).href);
  // Preserve the existing native controller/STDIN boundary and deadline. Only
  // the fixed child emitter is shared; no model or worker process starts here.
  const owned=String.raw`C:\ProgramData\<worker-root>\jobs\run\gmax-ready-${readyId}`;
  let correction='', runtimeRepair;
  if(repairFile){
    if(statSync(repairFile).size>131072)throw Error('Runtime repair specification exceeds bound');
    const {preparedManifestRead,prepareRuntimeRepair}=await import('./remote-embedding-runtime-repair.mjs');
    // Necessary input metadata inside this ONE overall170s operation; no native
    // verifier/model has started, and the deadline is never reset.
    const metadata=windowsPowerShell(worker,preparedManifestRead,{sshOpts:sshOpts(worker),timeoutMs:Math.max(1,deadline-Date.now()-8000)});
    if(metadata.code!==0)throw Error('Pinned manifest acquisition failed: '+metadata.err.slice(-500));
    const encoded=metadata.out.trim();const before=Buffer.from(encoded,'base64');
    if(before.length>8388608||before.toString('base64')!==encoded)throw Error('Invalid bounded manifest metadata');
    const repair=prepareRuntimeRepair(JSON.parse(readFileSync(repairFile,'utf8')),before,commit,originalManifest,owned);
    correction="[IO.File]::WriteAllText('${owned}.progress.json','{\"phase\":\"runtime-input-repair\"}',[Text.UTF8Encoding]::new($false));".replace('${owned}',owned)+repair.source;expectedManifest=repair.expectedManifest;runtimeRepair=repair.proof;
    writeFileSync(receipt+'.manifest-before.json',before,{flag:'wx',mode:0o600});
    writeFileSync(receipt+'.manifest-after.json',repair.manifest,{flag:'wx',mode:0o600});
  }
  const {source,requirements}=emitGmaxEmbeddingVerification({commit,expectedManifest,ownedStem:owned,deadlineMs:deadline-8000});
  const payload=`$ErrorActionPreference='Stop';try{${correction}$answer=& {${source}};[IO.File]::WriteAllText('${owned}.json',[string]$answer,[Text.UTF8Encoding]::new($false));exit 0}catch{[IO.File]::WriteAllText('${owned}.error',$_.Exception.Message,[Text.UTF8Encoding]::new($false));exit 75}`;
  const bytes=Buffer.from(payload,'utf16le');
  if(bytes.length>24*1024*1024)throw Error('Fixed verification payload exceeds bound');
  const payloadSha256=createHash('sha256').update(bytes).digest('hex');
  // Only this short hash-bound loader reaches CreateProcessW's command line.
  // The full verifier is staged once from the same bounded STDIN byte buffer.
  const loader=`$ErrorActionPreference='Stop';$bytes=[IO.File]::ReadAllBytes('${owned}.payload.ps1');$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -ne '${payloadSha256}'){throw 'Fixed verifier payload identity differs'};& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString($bytes)))`;
  const encodedLoader=Buffer.from(loader,'utf16le').toString('base64');
  const controller=`$code='C:\\ProgramData\\<worker-root>\\jobs\\job.cs';if((Get-FileHash -LiteralPath $code -Algorithm SHA256).Hash.ToLower() -ne 'f5a660e06bb53f56a5679e2f0e0da6636e49eeee3a3c076d8b7563ad3f6a15a7'){throw 'Prepared native helper identity differs'};[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"input"}');$buffer=New-Object byte[] ${bytes.length};$stream=[Console]::OpenStandardInput();$offset=0;while($offset -lt $buffer.Length){$n=$stream.Read($buffer,$offset,$buffer.Length-$offset);if($n -le 0){throw 'Fixed verification input incomplete'};$offset+=$n};$file=[IO.File]::Open('${owned}.payload.ps1',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$file.Write($buffer,0,$buffer.Length);$file.Flush()}finally{$file.Dispose()};[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"native-compile"}');Add-Type -Path $code -ErrorAction Stop;$left=[long]${deadline}-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-8000;if($left -le 0){throw 'Verification deadline reached'};[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"native-run"}');$native=[<job-class>]::RunEmbedding((Join-Path $PSHOME 'powershell.exe'),'${encodedLoader}','C:\\ProgramData\\<worker-root>',[int]$left,[uint64]2147483648,'${owned}.stop');[IO.File]::WriteAllText('${owned}.native.json',($native|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));$answer=if(Test-Path -LiteralPath '${owned}.json'){if((Get-Item -LiteralPath '${owned}.json').Length -gt 8388608){throw 'Verification output exceeds bound'};Get-Content -LiteralPath '${owned}.json' -Raw|ConvertFrom-Json}else{[pscustomobject]@{readOnly=$false;error=$(if(Test-Path -LiteralPath '${owned}.error'){Get-Content -LiteralPath '${owned}.error' -Raw}else{'Fixed verification returned no output'})}};$answer|Add-Member -NotePropertyName nativeScope -NotePropertyValue $native;foreach($field in @('progress','controller')){$phaseFile='${owned}.'+$field+'.json';if(Test-Path -LiteralPath $phaseFile){$answer|Add-Member -NotePropertyName $field -NotePropertyValue (Get-Content -LiteralPath $phaseFile -Raw|ConvertFrom-Json)}};if($native.CleanupConfirmed){foreach($suffix in @('.json','.error','.stop','.progress.json','.controller.json','.payload.ps1')){$temp='${owned}'+$suffix;if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force -ErrorAction Stop};if(Test-Path -LiteralPath $temp){throw 'Owned verification temporary file removal unconfirmed'}};$answer|Add-Member -NotePropertyName temporaryFilesRemoved -NotePropertyValue $true};$answer|ConvertTo-Json -Depth 25 -Compress`;
  const answer=windowsResult(windowsPowerShell(worker,controller,{sshOpts:sshOpts(worker),input:bytes,timeoutMs:Math.max(1,deadline-Date.now())}),'finalizing exact immutable prepared cache');
  answer.verificationRequirements={...requirements,payloadSha256};if(runtimeRepair)answer.runtimeRepair=runtimeRepair;writeFileSync(receipt,JSON.stringify(answer),{flag:'wx',mode:0o600});if(answer.readOnly!==true || answer.nativeScope?.ExitCode!==0 || answer.nativeScope?.CleanupConfirmed!==true || answer.temporaryFilesRemoved!==true || ['TimedOut','MemoryLimitHit','ResourceLimitHit','Cancelled'].some(k=>answer.nativeScope?.[k]===true) || answer.nativeScope?.StopReason) throw Error(answer.error ?? 'Fixed verification did not complete');console.log(JSON.stringify({readOnly:answer.readOnly,manifestSha256:answer.manifestSha256,aclEntriesChecked:answer.aclEntriesChecked}));
}catch(error){if(receipt&&!existsSync(receipt))writeFileSync(receipt,JSON.stringify({readOnly:false,verificationId:readyId,error:String(error.message).slice(0,2000)}),{flag:'wx',mode:0o600});console.error(error.message);process.exitCode=75;}

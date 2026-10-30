#!/usr/bin/env node
// Finalize only this explicitly selected immutable prepared cache; no model run.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [commit, receipt, readyId, originalManifest, repairFile] = process.argv.slice(2);
let expectedManifest=originalManifest;
const deadline = Date.now() + 170000;
let cleanupUnstartedPayload, nativeRpcStarted=false, ownedPayloadClaimed=false, claimRpcStarted=false, transferProof;
const remaining=(reserve=0)=>{const left=deadline-Date.now()-reserve;if(left<=0)throw Error('Verification absolute deadline reached');return left;};
try {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !receipt || existsSync(receipt) || !/^[a-f0-9]{32}$/.test(readyId ?? '') || !/^[a-f0-9]{64}$/.test(expectedManifest ?? '')) throw Error('Use <full-runtime-commit> <new-receipt>');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),platform=resolve(root,'../../platform');
  const {readRoster,operationSshWorker,sshOpts}=await import(pathToFileURL(join(platform,'scripts/worker-pool.mjs')).href);
  const {windowsPowerShell,windowsResult,WINDOWS_DIR,WINDOWS_JOB_ACCOUNT,WINDOWS_JOB_CLASS}=await import(pathToFileURL(join(platform,'scripts/lib/worker-windows.mjs')).href);
  const worker=operationSshWorker(readRoster().workers.find(w=>w.name==='dell-win'));
  const {emitGmaxEmbeddingVerification}=await import(pathToFileURL(join(platform,'scripts/lib/gmax-embedding-verify.mjs')).href);
  // Preserve the existing native controller and absolute deadline. Only
  // the fixed child emitter is shared; no model or worker process starts here.
  const owned=String.raw`${WINDOWS_DIR}\jobs\run\gmax-ready-${readyId}`;
  let correction='', runtimeRepair;
  if(repairFile){
    if(statSync(repairFile).size>131072)throw Error('Runtime repair specification exceeds bound');
    const {preparedManifestRead,prepareRuntimeRepair}=(await import('./remote-embedding-runtime-repair.mjs')).runtimeRepair(WINDOWS_JOB_ACCOUNT,WINDOWS_DIR);
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
  // Existing SCP transport owns exact payload bytes; no binary STDIN handoff.
  const localPayload=receipt+'.payload.ps1';
  writeFileSync(localPayload,bytes,{flag:'wx',mode:0o600});
  const claim=JSON.stringify({id:readyId,payloadSha256,bytes:bytes.length});
  const claimSha256=createHash('sha256').update(claim).digest('hex');
  cleanupUnstartedPayload=()=>{
    const source=`$claim='${owned}.transfer.json';if((Get-FileHash -LiteralPath $claim -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${claimSha256}'){throw 'Payload cleanup ownership differs'};foreach($p in @('${owned}.payload.ps1','${owned}.controller.json',$claim)){if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force -ErrorAction Stop};if(Test-Path -LiteralPath $p){throw 'Payload cleanup unconfirmed'}};[pscustomobject]@{cleanupConfirmed=$true;nativeStarted=$false}|ConvertTo-Json -Compress`;
    return windowsResult(windowsPowerShell(worker,source,{sshOpts:sshOpts(worker),timeoutMs:remaining()}),'removing owned unstarted verification payload');
  };
  const claimSource=`$claim='${owned}.transfer.json';$payload='${owned}.payload.ps1';$c=$false;$p=$false;try{$f=[IO.File]::Open($claim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$c=$true;try{$b=[Text.Encoding]::UTF8.GetBytes('${claim}');$f.Write($b,0,$b.Length)}finally{$f.Dispose()};$f=[IO.File]::Open($payload,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$p=$true;$f.Dispose();[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"payload-staging"}');[pscustomobject]@{claimed=$true;payload=$payload}|ConvertTo-Json -Compress}catch{$first=$_.Exception.Message;$cleanup=@();if($p){try{[IO.File]::Delete($payload)}catch{$cleanup+=@($_.Exception.Message)}};if($c){try{[IO.File]::Delete($claim)}catch{$cleanup+=@($_.Exception.Message)}};[pscustomobject]@{claimed=$false;firstFailure=$first;cleanupError=($cleanup -join '; ');cleanupConfirmed=($cleanup.Count -eq 0)}|ConvertTo-Json -Compress}`;
  claimRpcStarted=true;
  transferProof=windowsResult(windowsPowerShell(worker,claimSource,{sshOpts:sshOpts(worker),timeoutMs:remaining(8000)}),'claiming unique verification payload');
  if(transferProof.claimed!==true)throw Error(transferProof.firstFailure??'Verification payload ownership unconfirmed');
  ownedPayloadClaimed=true;
  const target=owned.replaceAll('\\','/')+'.payload.ps1';
  const staged=spawnSync('scp',['-O',...sshOpts(worker),localPayload,`${worker.target}:${target}`],{encoding:'utf8',timeout:remaining(8000),maxBuffer:1024*1024});
  if(staged.status!==0||staged.error)throw Error('Verification payload SCP failed: '+String(staged.error?.message??staged.stderr).slice(-500));
  const loader=`$ErrorActionPreference='Stop';$bytes=[IO.File]::ReadAllBytes('${owned}.payload.ps1');$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -ne '${payloadSha256}'){throw 'Fixed verifier payload identity differs'};& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString($bytes)))`;
  const encodedLoader=Buffer.from(loader,'utf16le').toString('base64');
  const controller=`
$code='${WINDOWS_DIR}\\jobs\\job.cs'
$native=$null;$nativeInvoked=$false;$firstFailure=$null;$cleanupError=$null;$claimMatches=$false;$answer=$null;$phase='payload-readback'
try {
  if((Get-FileHash -LiteralPath '${owned}.transfer.json' -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${claimSha256}'){throw 'Fixed verifier payload custody differs'}
  $claimMatches=$true
  if((Get-FileHash -LiteralPath $code -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f5a660e06bb53f56a5679e2f0e0da6636e49eeee3a3c076d8b7563ad3f6a15a7'){throw 'Prepared native helper identity differs'}
  [IO.File]::WriteAllText('${owned}.controller.json','{"phase":"payload-readback"}')
  $item=Get-Item -LiteralPath '${owned}.payload.ps1' -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne [long]${bytes.length}){throw 'Fixed verifier payload size/path differs'}
  if((Get-FileHash -LiteralPath '${owned}.payload.ps1' -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${payloadSha256}'){throw 'Fixed verifier staged payload differs'}
  $phase='native-compile';[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"native-compile"}')
  Add-Type -Path $code -ErrorAction Stop
  $left=[long]${deadline}-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-8000
  if($left -le 0){throw 'Verification deadline reached'}
  $phase='native-run';[IO.File]::WriteAllText('${owned}.controller.json','{"phase":"native-run"}')
  $nativeInvoked=$true
  $native=[${WINDOWS_JOB_CLASS}]::RunEmbedding((Join-Path $PSHOME 'powershell.exe'),'${encodedLoader}','${WINDOWS_DIR}',[int]$left,[uint64]2147483648,'${owned}.stop')
  [IO.File]::WriteAllText('${owned}.native.json',($native|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $phase='collect-result'
  if(Test-Path -LiteralPath '${owned}.json'){
    if((Get-Item -LiteralPath '${owned}.json').Length -gt 8388608){throw 'Verification output exceeds bound'}
    $answer=Get-Content -LiteralPath '${owned}.json' -Raw|ConvertFrom-Json
  }else{throw $(if(Test-Path -LiteralPath '${owned}.error'){Get-Content -LiteralPath '${owned}.error' -Raw}else{'Fixed verification returned no output'})}
}catch{
  $firstFailure=[pscustomobject]@{phase=$phase;message=$_.Exception.Message}
  $answer=[pscustomobject]@{readOnly=$false;error=$firstFailure.message}
}finally{
  if($null -eq $answer){$answer=[pscustomobject]@{readOnly=$false;error='Controller returned no result'}}
  foreach($field in @('progress','controller')){
    $file='${owned}.'+$field+'.json'
    if(Test-Path -LiteralPath $file){try{$answer|Add-Member -NotePropertyName $field -NotePropertyValue (Get-Content -LiteralPath $file -Raw|ConvertFrom-Json)}catch{$cleanupError='Phase evidence read failed: '+$_.Exception.Message}}
  }
  $removed=$false
  if($claimMatches -and ((-not $nativeInvoked) -or ($null -ne $native -and $native.CleanupConfirmed))){
    try{
      foreach($suffix in @('.json','.error','.stop','.payload.ps1','.progress.json','.controller.json','.transfer.json')){
        $file='${owned}'+$suffix
        if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force -ErrorAction Stop}
        if(Test-Path -LiteralPath $file){throw 'Owned verification temporary file removal unconfirmed'}
      }
      $removed=$true
    }catch{$cleanupError=$_.Exception.Message}
  }else{if($null -eq $cleanupError){$cleanupError='Owned native terminal/payload custody requires reconciliation'}}
  $answer|Add-Member -NotePropertyName nativeScope -NotePropertyValue $native
  $answer|Add-Member -NotePropertyName firstFailure -NotePropertyValue $firstFailure
  $answer|Add-Member -NotePropertyName cleanupError -NotePropertyValue $cleanupError
  $answer|Add-Member -NotePropertyName temporaryFilesRemoved -NotePropertyValue $removed
}
$answer|ConvertTo-Json -Depth 25 -Compress
`;
  const controllerTimeout=remaining();
  nativeRpcStarted=true;
  const answer=windowsResult(windowsPowerShell(worker,controller,{sshOpts:sshOpts(worker),timeoutMs:controllerTimeout}),'finalizing exact immutable prepared cache');
  answer.verificationRequirements={...requirements,payloadSha256,transport:'operation-owned-scp',payloadBytes:bytes.length};if(runtimeRepair)answer.runtimeRepair=runtimeRepair;writeFileSync(receipt,JSON.stringify(answer),{flag:'wx',mode:0o600});if(answer.readOnly!==true || answer.nativeScope?.ExitCode!==0 || answer.nativeScope?.CleanupConfirmed!==true || answer.temporaryFilesRemoved!==true || answer.cleanupError || ['TimedOut','MemoryLimitHit','ResourceLimitHit','Cancelled'].some(k=>answer.nativeScope?.[k]===true) || answer.nativeScope?.StopReason) throw Error(answer.error ?? 'Fixed verification did not complete');console.log(JSON.stringify({readOnly:answer.readOnly,manifestSha256:answer.manifestSha256,aclEntriesChecked:answer.aclEntriesChecked}));
 }catch(error){
  let cleanup={cleanupConfirmed:!ownedPayloadClaimed&&!claimRpcStarted,reason:nativeRpcStarted?'Native terminal custody requires reconciliation':claimRpcStarted?'Payload claim outcome requires reconciliation':'No payload claim'};
  if(transferProof?.claimed===false&&transferProof.cleanupConfirmed===true)cleanup={cleanupConfirmed:true,nativeStarted:false,reason:"Claim refused; owned partials removed"};
  if(ownedPayloadClaimed&&!nativeRpcStarted&&cleanupUnstartedPayload){
    try{cleanup=cleanupUnstartedPayload()}catch(cleanupError){cleanup={cleanupConfirmed:false,error:String(cleanupError.message).slice(0,600)}}
  }
  if(receipt&&!existsSync(receipt))writeFileSync(receipt,JSON.stringify({readOnly:false,verificationId:readyId,error:String(error.message).slice(0,2000),transferProof,nativeRpcStarted,cleanup}),{flag:'wx',mode:0o600});
  console.error(error.message);process.exitCode=75;
}

#!/usr/bin/env node
// Finalize only this explicitly selected immutable prepared cache; no model run.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [commit, receipt] = process.argv.slice(2);
try {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !receipt || existsSync(receipt)) throw Error('Use <full-runtime-commit> <new-receipt>');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),platform=resolve(root,'../../platform');
  const {readRoster,operationSshWorker,sshOpts}=await import(pathToFileURL(join(platform,'scripts/worker-pool.mjs')).href);
  const {windowsPowerShell,windowsResult}=await import(pathToFileURL(join(platform,'scripts/lib/worker-windows.mjs')).href);
  const worker=operationSshWorker(readRoster().workers.find(w=>w.name==='dell-win'));
  const key='7d2a762dbf95a7c04cb0046072440ab6b07ddb0db59440c3f2c8897441be1801-win32-x64-22.23.1';
  const source=`$base='C:/Users/<job-account>/gmax-cache/${key}';$manifest=Join-Path $base 'embedding/manifest.json';$m=Get-Content -LiteralPath $manifest -Raw|ConvertFrom-Json;if($m.runtime.commit -ne '${commit}' -or $m.runtime.platform -ne 'win32' -or $m.runtime.nodeVersion -ne '22.23.1'){throw 'Prepared identity differs'};$job=(Get-LocalUser -Name <job-account>).SID.Value;& icacls.exe $base /setowner '*S-1-5-32-544' /T /L /Q | Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned cache owner finalization failed'};& icacls.exe $base /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-18:(OI)(CI)(F)' ('*'+$job+':(OI)(CI)(RX)') /T /L /Q | Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned cache readonly ACL failed'};$all=@(Get-Item -LiteralPath $base)+@(Get-ChildItem -LiteralPath $base -Recurse -Force);$write=[int64]852310;foreach($p in $all){$acl=Get-Acl -LiteralPath $p.FullName;foreach($a in $acl.Access){$sid=$a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin @('S-1-5-32-544','S-1-5-18') -and $a.AccessControlType -eq 'Allow' -and (([int64]$a.FileSystemRights -band $write) -ne 0)){throw 'Prepared cache retains non-admin writer'}}};[pscustomobject]@{cacheRoot=$base;readOnly=$true;aclEntriesChecked=$all.Count;manifestSha256=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLower();manifest=$m}|ConvertTo-Json -Depth 20 -Compress`;
  const answer=windowsResult(windowsPowerShell(worker,source,{sshOpts:sshOpts(worker),timeoutMs:165000}),'finalizing exact immutable prepared cache');
  writeFileSync(receipt,JSON.stringify(answer),{flag:'wx',mode:0o600});console.log(JSON.stringify({readOnly:answer.readOnly,manifestSha256:answer.manifestSha256,aclEntriesChecked:answer.aclEntriesChecked}));
}catch(error){console.error(error.message);process.exitCode=75;}

#!/usr/bin/env node
// Fixed, read-only prerequisite for an expressly authorized guarded operation.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function readRemoteEmbeddingMetadata(workerName = 'dell-win') {
  if (workerName !== 'dell-win') throw new Error('Embedding preparation metadata currently selects dell-win only');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const platform = [resolve(root, '../platform'), resolve(root, '../../platform')]
    .find(p => existsSync(join(p, 'scripts/worker-pool.mjs')));
  if (!platform) throw new Error('Adjacent trusted worker transport missing');
  const { readRoster, operationSshWorker, sshOpts, networkPolicyAdmission } = await import(pathToFileURL(join(platform, 'scripts/worker-pool.mjs')).href);
  const { windowsPowerShell, windowsResult, WINDOWS_JOB_ACCOUNT, WINDOWS_DIR } = await import(pathToFileURL(join(platform, 'scripts/lib/worker-windows.mjs')).href);
  const selected = readRoster().workers.find(w => w.name === workerName);
  if (!selected || selected.platform !== 'windows-x64') throw new Error('Selected Windows worker is not admitted in the roster');
  const worker = operationSshWorker(selected);
  // The same cloned identity covers policy reads and the metadata command.
  const policy = networkPolicyAdmission(worker);
  if (!policy.ok) throw new Error(policy.detail);
  const source = String.raw`
$job = Get-LocalUser -Name '${WINDOWS_JOB_ACCOUNT}' -ErrorAction Stop
$profile = (Get-CimInstance Win32_UserProfile | Where-Object SID -eq $job.SID.Value).LocalPath
$cache = Join-Path $profile 'gmax-cache'
[pscustomobject]@{profile=$profile;nodeVersion=(& '${WINDOWS_DIR}\node.exe' --version);cacheExists=(Test-Path -LiteralPath $cache);cacheKeys=@(if(Test-Path -LiteralPath $cache){Get-ChildItem -LiteralPath $cache -Directory | Select-Object -ExpandProperty Name});embedding=@(if(Test-Path -LiteralPath $cache){Get-ChildItem -LiteralPath $cache -Directory | ForEach-Object { $m=Join-Path $_.FullName 'embedding\manifest.json';if(Test-Path -LiteralPath $m){[pscustomobject]@{key=$_.Name;manifest=(Get-Content -LiteralPath $m -Raw)}} }})} | ConvertTo-Json -Depth 5 -Compress
`;
  const answer = windowsPowerShell(worker, source, { sshOpts: sshOpts(worker), timeoutMs: 20000 });
  return { policy, ...windowsResult(answer, 'reading selected embedding preparation metadata') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--worker') throw new Error('Use --worker dell-win inside the approved owned guard');
    console.log(JSON.stringify(await readRemoteEmbeddingMetadata(args[1])));
  } catch (error) { console.error(error.message); process.exitCode = 75; }
}

// Exact selected raw-TS input correction, not a cache rebuild or runtime probe.
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');

// The prepared cache and owned job paths sit under the bridge's Windows job account and root.
export function runtimeRepair(account, dir) {
const PREPARED_CACHE = `C:/Users/${account}/gmax-cache/7d2a762dbf95a7c04cb0046072440ab6b07ddb0db59440c3f2c8897441be1801-win32-x64-22.23.1`;
const preparedManifestRead = `$p='${PREPARED_CACHE}/embedding/manifest.json';$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{if($f.Length -gt 8388608){throw 'Manifest exceeds bound'};$m=[IO.MemoryStream]::new();$f.CopyTo($m);[Convert]::ToBase64String($m.ToArray())}finally{$f.Dispose()}`;
function prepareRuntimeRepair(repair, before, commit, oldManifestSha, ownedStem) {
  const stemPrefix=dir+'\\jobs\\run\\gmax-ready-';
  const path='src/lib/workers/embeddings/colbert.ts';
  if(repair?.kind!=='exact-prepared-source-delta-v1'||repair.commit!==commit||repair.path!==path||repair.baseManifestSha256!==oldManifestSha||sha(before)!==oldManifestSha||!(ownedStem.startsWith(stemPrefix)&&/^[a-f0-9]{32}$/.test(ownedStem.slice(stemPrefix.length))))throw Error('Exact runtime repair identity differs');
  const content=Buffer.from(repair.contentBase64,'base64');
  if(content.length!==repair.bytes||content.length>65536||content.toString('base64')!==repair.contentBase64||sha(content)!==repair.newSha256)throw Error('Runtime replacement bytes differ');
  const manifest=JSON.parse(before.toString('utf8'));
  if(manifest.runtime.commit!==repair.baseCommit)throw Error('Runtime repair base commit differs');
  const matches=manifest.runtime.files.filter(f=>f.path===path);
  if(matches.length!==1||matches[0].sha256!==repair.oldSha256)throw Error('Runtime repair base file differs');
  Object.assign(matches[0],{bytes:content.length,sha256:repair.newSha256});manifest.runtime.commit=commit;
  const after=Buffer.from(JSON.stringify(manifest));const expectedManifest=sha(after);
  // Replace entries atomically instead of modifying an inode that could have
  // other hardlinks. Original bytes remain under the unique owned receipt stem.
  // Every existing ancestor is checked before opening; no shared cache ACL or
  // dependency/model file is changed by this correction.
  const source=`$base='${PREPARED_CACHE}';$runtime=Join-Path $base 'embedding/runtime';$file=Join-Path $runtime '${path}';$manifest=Join-Path $base 'embedding/manifest.json';foreach($p in @($base,(Join-Path $base 'embedding'),$runtime,(Join-Path $runtime 'src'),(Join-Path $runtime 'src/lib'),(Join-Path $runtime 'src/lib/workers'),(Join-Path $runtime 'src/lib/workers/embeddings'),$file,$manifest)){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime repair path redirects'}};function ReplaceExact($target,$expected,$encoded,$backup){$f=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{$h=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($h.ComputeHash($f))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};if($actual -ne $expected){throw 'Runtime repair prior bytes differ'}}finally{$f.Dispose()};$bytes=[Convert]::FromBase64String($encoded);$temp=$target+'.${ownedStem.split('-').at(-1)}.partial';$out=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$out.Write($bytes,0,$bytes.Length);$out.Flush()}finally{$out.Dispose()};[IO.File]::Replace($temp,$target,$backup)};ReplaceExact $file '${repair.oldSha256}' '${content.toString('base64')}' '${ownedStem}.colbert.before';[IO.File]::WriteAllText('${ownedStem}.progress.json','{"phase":"runtime-source-replaced"}');ReplaceExact $manifest '${oldManifestSha}' '${after.toString('base64')}' '${ownedStem}.manifest.before';[IO.File]::WriteAllText('${ownedStem}.progress.json','{"phase":"runtime-manifest-replaced"}');`;
  return {source,expectedManifest,manifest:after,proof:{baseCommit:repair.baseCommit,commit,path,oldSha256:repair.oldSha256,newSha256:repair.newSha256,baseManifestSha256:oldManifestSha,manifestSha256:expectedManifest,rawTypeScript:true,dependencyAndModelBytesUnchanged:true,backups:[ownedStem+'.colbert.before',ownedStem+'.manifest.before']}};
}
return {PREPARED_CACHE, preparedManifestRead, prepareRuntimeRepair};
}

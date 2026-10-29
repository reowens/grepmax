"""Validate published files and retain the exact installed dependency tree; no runtime probes."""
from pathlib import Path
import hashlib,json,shutil,subprocess,tarfile
STATE=Path('/home/reoiv/.local/state/gmax-handover/20261029T010000Z-0.26.105')
RELEASE=Path('/home/reoiv/.local/state/gmax-delivery/20261029-0.26.105')
STAGE=STATE/'stage/lib/node_modules/grepmax'
INSTALL=Path('/home/reoiv/.local/lib/node_modules/grepmax')
subprocess.run(['bash','scripts/postrelease.sh','--install'],check=True)
receipt=json.loads((RELEASE/'release-SOURCE-ARTIFACT.json').read_text())
archive=RELEASE/receipt['archive']
assert hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==receipt['sha256']
matching=0
with tarfile.open(archive) as package:
 for member in package:
  assert member.isfile()
  relative=Path(member.name).relative_to('package')
  target=STAGE/relative
  assert target.is_file() and hashlib.file_digest(target.open('rb'),'sha256').digest()==hashlib.file_digest(package.extractfile(member),'sha256').digest(),str(relative)
  if member.mode&0o111:assert target.stat().st_mode&0o111,str(relative)
  matching+=1
assert matching==331
(STATE/'stage-validation.json').write_text(json.dumps({'matchingFiles':matching,'source':'published qualified0.26.105 archive','archiveSha256':receipt['sha256']},indent=2)+'\n')
previous=json.loads((INSTALL/'package.json').read_text());next_=json.loads((STAGE/'package.json').read_text())
for key in ['dependencies','optionalDependencies']:assert previous[key]==next_[key],key
assert previous['version']=='0.26.104' and next_['version']=='0.26.105'
(STAGE/'node_modules').rename(STATE/'npm-resolved-dependencies')
shutil.copytree(INSTALL/'node_modules',STAGE/'node_modules',symlinks=True,copy_function=shutil.copy2)
(STATE/'dependency-compatibility.json').write_text(json.dumps({'ok':True,'strategy':'Retained exact working dependency tree from0.26.104; unchanged dependency manifests; newly resolved tree preserved separately','productionDependenciesChanged':False},indent=2)+'\n')
print('Published package files matched; exact previous working dependencies retained',flush=True)

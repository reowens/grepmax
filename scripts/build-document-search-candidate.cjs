// Build a reviewable local candidate; never touch the checkout dist or run lifecycle scripts.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=process.argv[2];
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Supply a new absolute output directory');
const stage=path.join(out,'stage'),extract=path.join(out,'extracted');fs.mkdirSync(stage,{recursive:true});fs.mkdirSync(extract);
function run(command,args,cwd=root){const r=cp.spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000});if(r.error||r.status!==0)throw Error(r.error??r.stderr??r.stdout);return r.stdout;}
run(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--outDir',path.join(stage,'dist'),'--incremental','false']);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
run(process.execPath,[path.join(root,'scripts/prepare-lance-runtime.cjs'),path.join(stage,'dist/vendor/lancedb')]);
fs.copyFileSync(path.join(root,'package.json'),path.join(stage,'package.json'));
for(const item of manifest.files.filter(f=>f!=='dist'))if(fs.existsSync(path.join(root,item))){fs.mkdirSync(path.dirname(path.join(stage,item)),{recursive:true});fs.cpSync(path.join(root,item),path.join(stage,item),{recursive:true,filter:p=>!p.split(path.sep).some(part=>['.venv','__pycache__','.git','node_modules'].includes(part))});}
const packOutput=JSON.parse(run(process.platform==='win32'?'npm.cmd':'npm',['pack','--ignore-scripts','--json','--pack-destination',out],stage));
const metadata=(Array.isArray(packOutput)?packOutput:Object.values(packOutput))[0];
if(!metadata?.filename)throw Error('npm pack returned no tarball metadata');
fs.writeFileSync(path.join(out,'pack.json'),JSON.stringify(metadata,null,2)+'\n');
run('tar',['-xzf',path.join(out,metadata.filename),'-C',extract]);
console.log(JSON.stringify({version:manifest.version,archive:path.join(out,metadata.filename),packageRoot:path.join(extract,'package'),sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(out,metadata.filename))).digest('hex'),lifecycleScripts:false},null,2));

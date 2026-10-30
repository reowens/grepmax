#!/usr/bin/env node
// Resume only a previously captured fixed dependency preparation after proven cleanup.
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
try {
  if (args.length !== 6 || args[0] !== '--job' || args[2] !== '--cleanup-receipt' || args[4] !== '--receipt' || !/^[a-f0-9]{32}$/.test(args[1])) throw Error('Use --job <preparation-id> --cleanup-receipt <owned-proof> --receipt <new-result>');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const platform = [resolve(root,'../platform'),resolve(root,'../../platform')].find(p=>existsSync(join(p,'scripts/gmax-worker.mjs')));
  if (!platform) throw Error('Trusted fixed transport absent');
  if (existsSync(args[5])) throw Error('Refusing to overwrite resume receipt');
  const proof = JSON.parse(readFileSync(args[3],'utf8'));
  if (proof.outerJobId !== args[1] || proof.cleanupConfirmed !== true || proof.removed?.removed !== true || proof.released?.ok !== true || proof.final?.state === 'Running') throw Error('Previous owned preparation cleanup not confirmed');
  const {readRoster,operationSshWorker}=await import(pathToFileURL(join(platform,'scripts/worker-pool.mjs')).href);
  const {validateGmaxRequest,checkGmaxSource,gmaxInputPath,gmaxOutputRoot,gmaxBridgeCommand}=await import(pathToFileURL(join(platform,'scripts/lib/gmax-project.mjs')).href);
  const {runJob}=await import(pathToFileURL(join(platform,'scripts/worker-job.mjs')).href);
  const input=gmaxInputPath(args[1]),file=join(platform,input),st=lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>88*1024**2)throw Error('Invalid captured preparation packet');
  const packet=JSON.parse(readFileSync(file,'utf8')),request=validateGmaxRequest(packet.request);
  if(request.jobId!==args[1]||request.task!=='prepare'||request.worker!=='dell-win'||Object.keys(packet).sort().join()!=='request,sourceBase64')throw Error('Only exact captured Dell dependency preparation can resume');
  const bytes=Buffer.from(packet.sourceBase64,'base64');if(bytes.toString('base64')!==packet.sourceBase64)throw Error('Invalid source encoding');
  checkGmaxSource(bytes,request);
  const output=gmaxOutputRoot(request.jobId);
  if(existsSync(join(platform,output,'result.json')))throw Error('Prior result exists; reconcile it instead of resubmitting');
  const workers=readRoster().workers.map(operationSshWorker);
  const record={request,resumedCapturedPacket:true,previousCleanup:resolve(args[3]),state:'submitting'};
  writeFileSync(args[5],JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
  const result=await runJob({lane:'typecheck',worker:'dell-win',command:gmaxBridgeCommand(request.jobId),deps:false,allowFallback:false,demandGb:2,put:[input],fetch:[`${output}/result.json`,`${output}/stdout.log`],timeoutS:140,log:`${output}.resume.transport.log`},{root:platform,workers});
  writeFileSync(args[5],JSON.stringify({...record,state:'settled',result},null,2));
  console.log(JSON.stringify(result));process.exitCode=result.exit??75;
} catch(error){console.error(error.message);process.exitCode=75;}

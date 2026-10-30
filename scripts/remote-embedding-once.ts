// One explicitly approved synthetic hybrid batch through the production client.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RemoteEmbeddingClient } from "../src/lib/workers/remote-embedding/client";
import { preparedEmbeddingDigests, validatePreparedEmbeddingManifest } from "../src/lib/workers/remote-embedding-artifacts";
import { validatePreparedEmbeddingIdentity } from "../src/lib/workers/remote-embedding/protocol";
import type { ProcessFileResult } from "../src/lib/workers/orchestrator";
let activeReceipt: string | undefined;
let custodyFile: string | undefined;
async function main() {
  const [readyFile, assetsFile, receipt] = process.argv.slice(2);
  if (!readyFile || !assetsFile || !receipt || fs.existsSync(receipt)) throw Error("Use verified-ready assets new-receipt");
  const ready=JSON.parse(fs.readFileSync(readyFile,"utf8")), assets=JSON.parse(fs.readFileSync(assetsFile,"utf8"));
  if(ready.readOnly!==true)throw Error("Readonly prepared cache proof required");
  const manifest=validatePreparedEmbeddingManifest(ready.manifest);
  const identity=validatePreparedEmbeddingIdentity({generation:assets.spec.generation,...preparedEmbeddingDigests(manifest),colbertDim:48});
  const texts=["File: example.ts\nfunction formatLabel(value: string): string { return value.trim(); }"];
  const hash=createHash("sha256").update(texts.join("\n")).digest("hex");
  const file={hash,mtimeMs:0,size:Buffer.byteLength(texts[0]),vectors:texts.map(()=>({})),remoteChunks:texts.map((text,index)=>({index,text}))} as ProcessFileResult;
  const owner=path.dirname(receipt);fs.mkdirSync(owner,{recursive:true,mode:0o700});
  custodyFile=path.join(owner,"custody.json");
  fs.writeFileSync(receipt,JSON.stringify({state:"submitting",submittedRequests:1,actualInferenceJobs:"unconfirmed until native result",identity,manifestSha256:ready.manifestSha256},null,2),{flag:"wx",mode:0o600});
  activeReceipt=receipt;
  const client=new RemoteEmbeddingClient(undefined,custodyFile);
  const output=await client.complete(file,{mode:"remote",worker:"dell-win",runtimeCheckout:path.resolve(__dirname,".."),runtimeCommit:manifest.runtime.commit,identity});
  const summary=output.vectors.map(v=>{const dense=Array.from(v.vector),pooled=Array.from(v.pooled_colbert_48d??[]);const denseNorm=Math.hypot(...dense),pooledNorm=Math.hypot(...pooled);if(Math.abs(denseNorm-1)>0.005||Math.abs(pooledNorm-1)>0.005)throw Error("Returned vectors not unit normalized");return{denseDim:dense.length,denseNorm,pooledDim:pooled.length,pooledNorm,tokens:v.doc_token_ids?.length,packedBytes:v.colbert?.length,scale:v.colbert_scale};});
  fs.writeFileSync(receipt,JSON.stringify({state:"completed",actualInferenceJobs:1,identity,vectors:summary,terminalCleanupConfirmed:!fs.existsSync(path.join(owner,"custody.json")),manifestSha256:ready.manifestSha256,numericParity:"not established; no local reference inference"},null,2),{mode:0o600});console.log(JSON.stringify(summary));
}
void main().catch(error=>{
  if(activeReceipt){
    const prior=JSON.parse(fs.readFileSync(activeReceipt,"utf8"));
    const custodyRetained=Boolean(custodyFile&&fs.existsSync(custodyFile));
    fs.writeFileSync(activeReceipt,JSON.stringify({...prior,state:"failed",error:String(error.message).slice(0,2000),custodyRetained,...(custodyRetained?{custody:JSON.parse(fs.readFileSync(custodyFile!,"utf8"))}:{})},null,2),{mode:0o600});
  }
  console.error(error.message);process.exitCode=75;
});

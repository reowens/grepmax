import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { BackgroundEmbeddingConfig, RemoteEmbeddingTransport } from "./client";
import type { RemoteEmbeddingRequest } from "./protocol";

const senderRoot = path.resolve(__dirname, "../../../..");
export const fixedWorkerTransport: RemoteEmbeddingTransport = {
  capability(config: BackgroundEmbeddingConfig) {
    const root = config.runtimeCheckout ?? "";
    const present = process.platform === "linux" && path.isAbsolute(root) && ["scripts/guard-local-operation.py", "scripts/remote-embedding-submit.mjs"].every(p => fs.existsSync(path.join(senderRoot,p)));
    return { available:present, reason:present ? "Fixed sender present; host admission/prepared artifacts are not observed" : "Pinned Linux sender runtime/guard missing" };
  },
  async submit(request: RemoteEmbeddingRequest, config: BackgroundEmbeddingConfig, signal: AbortSignal) {
    if (!config.runtimeCheckout) throw new Error("Pinned sender checkout missing");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),"gmax-embedding-submit-"));
    const input=path.join(dir,"request.json"), output=path.join(dir,"response.json"), receipt=path.join(dir,"guard.json");
    fs.writeFileSync(input,JSON.stringify({request,config}),{mode:0o600});
    try {
      const code = await new Promise<number | null>((resolve,reject) => {
        const child = spawn("python3",[path.join(senderRoot,"scripts/guard-local-operation.py"),"--receipt",receipt,"--log",path.join(dir,"guard.log"),"--cwd",config.runtimeCheckout!,"--operation","remote-background-embedding","--no-autostart","--",process.execPath,path.join(senderRoot,"scripts/remote-embedding-submit.mjs"),input,output],{stdio:["pipe","ignore","pipe"],shell:false});
        const abort=()=>{if(child.stdin.writable) child.stdin.write("cancel\n");};
        signal.addEventListener("abort",abort,{once:true}); if(signal.aborted) abort();
        child.stdin.on("error",()=>{}); child.stderr.on("data",()=>{});
        child.once("error",error=>{signal.removeEventListener("abort",abort);reject(error);});
        child.once("close",value=>{signal.removeEventListener("abort",abort);resolve(value);});
      });
      if (code !== 0 || !fs.existsSync(receipt) || !fs.existsSync(output)) throw new Error("Sender guard failed; remote terminal state unknown");
      if(fs.statSync(receipt).size>1024*1024 || fs.statSync(output).size>13*1024*1024) throw new Error("Sender evidence exceeds bound");
      const guard=JSON.parse(fs.readFileSync(receipt,"utf8")) as {outcome?:string;cohortEmpty?:boolean;ownedCgroupRemoved?:boolean};
      if(guard.outcome!=="passed" || !guard.cohortEmpty || !guard.ownedCgroupRemoved) throw new Error("Sender owned cleanup unconfirmed");
      const reply=JSON.parse(fs.readFileSync(output,"utf8")) as {terminal?:boolean;cleanupConfirmed?:boolean;embeddings?:unknown};
      return { result:reply.embeddings, terminal:reply.terminal===true, cleanupConfirmed:reply.cleanupConfirmed===true };
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  },
};

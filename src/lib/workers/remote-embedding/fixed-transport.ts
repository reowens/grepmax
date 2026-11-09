import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config";
import type {
  BackgroundEmbeddingConfig,
  RemoteEmbeddingTransport,
  RemoteJobIdentity,
} from "./client";
import type { RemoteEmbeddingRequest } from "./protocol";

const senderRoot = path.resolve(__dirname, "../../../..");
export const fixedWorkerTransport: RemoteEmbeddingTransport = {
  capability(config: BackgroundEmbeddingConfig) {
    const root = config.runtimeCheckout ?? "";
    const bridge = [
      path.resolve(root, "../platform"),
      path.resolve(root, "../../platform"),
    ].some((p) => fs.existsSync(path.join(p, "scripts/gmax-worker.mjs")));
    const present =
      bridge &&
      process.platform === "linux" &&
      path.isAbsolute(root) &&
      [
        "scripts/guard-local-operation.py",
        "scripts/remote-embedding-submit.mjs",
      ].every((p) => fs.existsSync(path.join(senderRoot, p)));
    return {
      available: present,
      reason: present
        ? "Fixed sender present; host admission/prepared artifacts are not observed"
        : "Pinned Linux sender runtime/guard missing",
    };
  },
  async submit(
    request: RemoteEmbeddingRequest,
    config: BackgroundEmbeddingConfig,
    signal: AbortSignal,
    onIdentity?: (identity: RemoteJobIdentity) => void,
  ) {
    if (!config.runtimeCheckout)
      throw new Error("Pinned sender checkout missing");
    const records = path.join(PATHS.globalRoot, "remote-embedding-records");
    fs.mkdirSync(records, { recursive: true, mode: 0o700 });
    const dir = path.join(records, request.jobId);
    fs.mkdirSync(dir, { mode: 0o700 });
    const input = path.join(dir, "request.json"),
      output = path.join(dir, "response.json"),
      receipt = path.join(dir, "guard.json");
    fs.writeFileSync(input, JSON.stringify({ request, config }), {
      mode: 0o600,
    });
    const remember = () => {
      const file = path.join(dir, "identity.json");
      if (!fs.existsSync(file)) return;
      if (fs.lstatSync(file).size > 8192)
        throw new Error("Remote identity exceeds bound");
      const identity = JSON.parse(
        fs.readFileSync(file, "utf8"),
      ) as RemoteJobIdentity;
      if (identity.jobId !== request.jobId)
        throw new Error("Remote identity request differs");
      onIdentity?.(identity);
    };
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          "python3",
          [
            path.join(senderRoot, "scripts/guard-local-operation.py"),
            "--receipt",
            receipt,
            "--log",
            path.join(dir, "guard.log"),
            "--cwd",
            config.runtimeCheckout!,
            "--operation",
            "remote-background-embedding",
            "--no-autostart",
            "--memory-max-bytes",
            "2147483648",
            "--",
            process.execPath,
            path.join(senderRoot, "scripts/remote-embedding-submit.mjs"),
            input,
            output,
          ],
          { stdio: ["pipe", "ignore", "pipe"], shell: false },
        );
        const abort = () => {
          if (child.stdin.writable) child.stdin.write("cancel\n");
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdin.on("error", () => {});
        child.stderr.on("data", () => {});
        child.once("error", (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        });
        child.once("close", (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
      remember();
      if (code !== 0 || !fs.existsSync(receipt) || !fs.existsSync(output))
        throw new Error("Sender guard failed; remote terminal state unknown");
      if (
        fs.statSync(receipt).size > 1024 * 1024 ||
        fs.statSync(output).size > 13 * 1024 * 1024
      )
        throw new Error("Sender evidence exceeds bound");
      const guard = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
        outcome?: string;
        cohortEmpty?: boolean;
        ownedCgroupRemoved?: boolean;
      };
      if (
        guard.outcome !== "passed" ||
        !guard.cohortEmpty ||
        !guard.ownedCgroupRemoved
      )
        throw new Error("Sender owned cleanup unconfirmed");
      const reply = JSON.parse(fs.readFileSync(output, "utf8")) as {
        terminal?: boolean;
        cleanupConfirmed?: boolean;
        embeddings?: unknown;
        jobId?: string;
        remoteJobId?: string;
        remoteTaskId?: string;
        state?: string;
        reason?: string;
      };
      if (reply.remoteJobId) {
        if (reply.jobId !== request.jobId)
          throw new Error("Final remote identity differs");
        onIdentity?.({
          jobId: request.jobId,
          remoteJobId: reply.remoteJobId,
          ...(reply.remoteTaskId ? { remoteTaskId: reply.remoteTaskId } : {}),
        });
      }
      const error =
        reply.state === "completed"
          ? undefined
          : reply.state === "refused"
            ? String(reply.reason ?? "Worker refused admission")
                .replace(/[\r\n]/g, " ")
                .slice(0, 300)
            : "Remote worker failed or returned no terminal result; inspect owned receipt";
      return {
        result: reply.embeddings,
        terminal: reply.terminal === true,
        cleanupConfirmed: reply.cleanupConfirmed === true,
        ...(error ? { error } : {}),
      };
    } finally {
      // Keep small guard/identity evidence for uncertain cleanup, never chunk text or vectors.
      fs.rmSync(input, { force: true });
      fs.rmSync(output, { force: true });
    }
  },
};

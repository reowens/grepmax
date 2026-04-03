import process from "node:process";
process.title = "gmax-worker";
import processFile, {
  encodeQuery,
  type ProcessFileInput,
  type ProcessFileResult,
  type RerankDoc,
  rerank,
} from "./worker";
import { debug } from "../utils/logger";

type IncomingMessage =
  | { id: number; method: "processFile"; payload: ProcessFileInput }
  | { id: number; method: "encodeQuery"; payload: { text: string } }
  | {
      id: number;
      method: "rerank";
      payload: { query: number[][]; docs: RerankDoc[]; colbertDim: number };
    };

type OutgoingMessage =
  | { id: number; result: ProcessFileResult }
  | { id: number; result: Awaited<ReturnType<typeof encodeQuery>> }
  | { id: number; result: Awaited<ReturnType<typeof rerank>> }
  | { id: number; error: string }
  | { id: number; heartbeat: true };

const send = (msg: OutgoingMessage) => {
  if (process.send) {
    process.send(msg);
  }
};

process.on("message", async (msg: IncomingMessage) => {
  const { id, method, payload } = msg;
  const start = performance.now();
  debug("worker", `recv task=${id} method=${method}${method === "processFile" ? ` file=${(payload as ProcessFileInput).path}` : ""}`);
  try {
    if (method === "processFile") {
      const onProgress = () => {
        send({ id, heartbeat: true });
      };
      const result = await processFile(payload, onProgress);
      debug("worker", `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms vectors=${result.vectors.length} file=${(payload as ProcessFileInput).path}`);
      send({ id, result });
      return;
    }
    if (method === "encodeQuery") {
      const result = await encodeQuery(payload);
      debug("worker", `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms`);
      send({ id, result });
      return;
    }
    if (method === "rerank") {
      const result = await rerank(payload);
      debug("worker", `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms`);
      send({ id, result });
      return;
    }
    send({ id, error: `Unknown method: ${method}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug("worker", `fail task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms: ${message}`);
    send({ id, error: message });
  }
});

process.on("uncaughtException", (err) => {
  console.error("[process-worker] uncaughtException", err);
  process.exitCode = 1;
  process.exit();
});

process.on("unhandledRejection", (reason) => {
  console.error("[process-worker] unhandledRejection", reason);
  process.exitCode = 1;
  process.exit();
});

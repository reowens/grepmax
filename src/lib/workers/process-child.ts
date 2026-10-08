import process from "node:process";

process.title = "gmax-worker";

import {
  debug,
  installTimestampedOutput,
  LOG_TIMESTAMPS_ENV,
} from "../utils/logger";
import { createSerializedHandler } from "./serialized-handler";
import processFile, {
  encodeQuery,
  isExistingQueryReady,
  type ProcessFileInput,
  type ProcessFileResult,
  type RerankDoc,
  rerank,
} from "./worker";

// Workers inherit the daemon's stdio (daemon.log) — stamp lines the same way
// the daemon does. No-op for workers forked by interactive CLI commands.
if (process.env[LOG_TIMESTAMPS_ENV] === "1") installTimestampedOutput();

type IncomingMessage =
  | { id: number; method: "processFile"; payload: ProcessFileInput }
  | {
      id: number;
      method: "encodeQuery";
      payload: { text: string; existingOnly?: boolean; generation?: string };
    }
  | {
      id: number;
      method: "rerank";
      payload: { query: number[][]; docs: RerankDoc[]; colbertDim: number };
    };

type OutgoingMessage =
  | { id: number; result: ProcessFileResult }
  | { id: number; result: Awaited<ReturnType<typeof encodeQuery>> }
  | { id: number; result: Awaited<ReturnType<typeof rerank>> }
  | { id: number; error: string; code?: string }
  | { id: number; heartbeat: true };

// Every outgoing message also carries `rss` (see send()).

const send = (msg: OutgoingMessage) => {
  if (process.send) {
    // Attach current RSS so the pool can recycle workers whose native (ONNX)
    // memory has ballooned — the V8 --max-old-space-size cap can't see it.
    process.send({
      ...msg,
      rss: process.memoryUsage().rss,
      queryReady: isExistingQueryReady(),
    });
  }
};

let restrictedInFlight = false;
const handleMessage = async (msg: IncomingMessage) => {
  const { id, method, payload } = msg;
  restrictedInFlight =
    method === "encodeQuery" && payload.existingOnly === true;
  const start = performance.now();
  debug(
    "worker",
    `recv task=${id} method=${method}${method === "processFile" ? ` file=${(payload as ProcessFileInput).path}` : ""}`,
  );
  try {
    if (method === "processFile") {
      const onProgress = () => {
        send({ id, heartbeat: true });
      };
      const result = await processFile(payload, onProgress);
      debug(
        "worker",
        `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms vectors=${result.vectors.length} file=${(payload as ProcessFileInput).path}`,
      );
      send({ id, result });
      return;
    }
    if (method === "encodeQuery") {
      const result = await encodeQuery(payload);
      debug(
        "worker",
        `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms`,
      );
      send({ id, result });
      return;
    }
    if (method === "rerank") {
      const result = await rerank(payload);
      debug(
        "worker",
        `done task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms`,
      );
      send({ id, result });
      return;
    }
    send({ id, error: `Unknown method: ${method}` });
  } catch (err) {
    const rawCode = (err as { code?: unknown })?.code;
    const safeCode =
      typeof rawCode === "string" &&
      ["host_pressure", "embedding_mismatch", "embedding_unavailable"].includes(
        rawCode,
      )
        ? rawCode
        : "embedding_unavailable";
    const message = restrictedInFlight
      ? safeCode
      : err instanceof Error
        ? err.message
        : String(err);
    debug(
      "worker",
      `fail task=${id} method=${method} ${(performance.now() - start).toFixed(0)}ms: ${message}`,
    );
    const code = restrictedInFlight
      ? safeCode
      : (err as { code?: unknown })?.code;
    send({ id, error: message, ...(typeof code === "string" ? { code } : {}) });
  } finally {
    restrictedInFlight = false;
  }
};

const handleMessageSerially = createSerializedHandler(handleMessage);
process.on("message", (msg: IncomingMessage) => {
  void handleMessageSerially(msg);
});

process.on("uncaughtException", (err) => {
  console.error(
    "[process-worker] uncaughtException",
    restrictedInFlight ? "restricted query failed" : err,
  );
  process.exitCode = 1;
  process.exit();
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "[process-worker] unhandledRejection",
    restrictedInFlight ? "restricted query failed" : reason,
  );
  process.exitCode = 1;
  process.exit();
});

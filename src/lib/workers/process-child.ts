import process from "node:process";
import type { VectorRecord } from "../store/types";
import processFile, { encodeQuery, rerank } from "./worker";

type IncomingMessage =
  | { id: number; method: "processFile"; payload: any }
  | { id: number; method: "encodeQuery"; payload: any }
  | { id: number; method: "rerank"; payload: any };

type OutgoingMessage =
  | { id: number; result: VectorRecord[] | any }
  | { id: number; error: string };

const send = (msg: OutgoingMessage) => {
  if (process.send) {
    process.send(msg);
  }
};

process.on("message", async (msg: IncomingMessage) => {
  const { id, method, payload } = msg;
  try {
    if (method === "processFile") {
      const result = await processFile(payload);
      send({ id, result });
      return;
    }
    if (method === "encodeQuery") {
      const result = await encodeQuery(payload);
      send({ id, result });
      return;
    }
    if (method === "rerank") {
      const result = await rerank(payload);
      send({ id, result });
      return;
    }
    send({ id, error: `Unknown method: ${method}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

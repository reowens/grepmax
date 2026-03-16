/**
 * LLM summarizer HTTP client.
 * Talks to the MLX summarizer server to generate code summaries.
 * Returns null if server isn't running — caller skips summaries gracefully.
 */

import * as http from "node:http";

const SUMMARY_PORT = parseInt(
  process.env.GMAX_SUMMARY_PORT || "8101",
  10,
);
const SUMMARY_HOST = "127.0.0.1";
const SUMMARY_TIMEOUT_MS = 120_000; // 2 min — batches of chunks take time

let summarizerAvailable: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 5_000; // short cache — retry quickly if server just started

interface ChunkInput {
  code: string;
  language: string;
  file: string;
}

function postJSON(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; data?: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: SUMMARY_HOST,
        port: SUMMARY_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: SUMMARY_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            resolve({ ok: res.statusCode === 200, data });
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.write(payload);
    req.end();
  });
}

async function isSummarizerUp(): Promise<boolean> {
  const now = Date.now();
  if (summarizerAvailable !== null && now - lastCheck < CHECK_INTERVAL_MS) {
    return summarizerAvailable;
  }

  const result = await new Promise<boolean>((resolve) => {
    const req = http.get(
      {
        hostname: SUMMARY_HOST,
        port: SUMMARY_PORT,
        path: "/health",
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });

  summarizerAvailable = result;
  lastCheck = now;
  return result;
}

/**
 * Generate summaries for code chunks via the local LLM server.
 * Sends one chunk at a time. Skips health check — just tries the request.
 * If the server is busy, the TCP connection queues until it's ready.
 * Returns string[] on success, null if server unavailable.
 */
export async function summarizeChunks(
  chunks: ChunkInput[],
): Promise<string[] | null> {
  if (chunks.length === 0) return [];

  // Quick check only if we've never connected
  if (summarizerAvailable === null) {
    summarizerAvailable = await isSummarizerUp();
    if (!summarizerAvailable) return null;
  }
  if (summarizerAvailable === false) {
    // Recheck periodically
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL_MS) return null;
    summarizerAvailable = await isSummarizerUp();
    if (!summarizerAvailable) return null;
  }

  const summaries: string[] = [];
  for (const chunk of chunks) {
    const { ok, data } = await postJSON("/summarize", {
      chunks: [chunk],
    });
    if (!ok || !data?.summaries?.[0]) {
      summaries.push("");
    } else {
      summaries.push(data.summaries[0]);
    }
  }

  return summaries;
}

export function resetSummarizerCache(): void {
  summarizerAvailable = null;
  lastCheck = 0;
}

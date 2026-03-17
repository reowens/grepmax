/**
 * LLM summarizer HTTP client.
 * Talks to the MLX summarizer server to generate code summaries.
 * Returns null if server isn't running — caller skips summaries gracefully.
 *
 * Called from the main syncer process (not worker processes) to avoid
 * GPU contention from multiple concurrent workers.
 */

import * as http from "node:http";

const SUMMARY_PORT = parseInt(
  process.env.GMAX_SUMMARY_PORT || "8101",
  10,
);
const SUMMARY_HOST = "127.0.0.1";
const SUMMARY_TIMEOUT_MS = 120_000;

interface ChunkInput {
  code: string;
  language: string;
  file: string;
  symbols?: string[];
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

/**
 * Generate summaries for code chunks via the local LLM server.
 * Returns string[] on success, null if server unavailable.
 */
export async function summarizeChunks(
  chunks: ChunkInput[],
): Promise<string[] | null> {
  if (chunks.length === 0) return [];

  const { ok, data } = await postJSON("/summarize", { chunks });
  if (!ok || !data?.summaries) {
    return null;
  }

  return data.summaries as string[];
}

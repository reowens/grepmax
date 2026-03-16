/**
 * MLX embedding server HTTP client.
 * Tries the local MLX GPU server for dense embeddings.
 * Returns null if the server isn't running — caller falls back to ONNX.
 */

import * as http from "node:http";

const MLX_PORT = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
const MLX_HOST = "127.0.0.1";
const MLX_TIMEOUT_MS = 10_000;
const EMBED_MODE = process.env.GMAX_EMBED_MODE || "auto";

let mlxAvailable: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 30_000;

function postJSON(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; data?: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: MLX_HOST,
        port: MLX_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: MLX_TIMEOUT_MS,
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
 * Check if MLX server is reachable. Caches result for CHECK_INTERVAL_MS.
 */
async function isMlxUp(): Promise<boolean> {
  const now = Date.now();
  if (mlxAvailable !== null && now - lastCheck < CHECK_INTERVAL_MS) {
    return mlxAvailable;
  }

  const result = await new Promise<boolean>((resolve) => {
    const req = http.get(
      { hostname: MLX_HOST, port: MLX_PORT, path: "/health", timeout: 2000 },
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

  mlxAvailable = result;
  lastCheck = now;
  return result;
}

/**
 * Get dense embeddings from MLX server.
 * Returns Float32Array[] on success, null if server unavailable.
 */
export async function mlxEmbed(
  texts: string[],
): Promise<Float32Array[] | null> {
  if (EMBED_MODE === "cpu") return null;
  if (!(await isMlxUp())) return null;

  const { ok, data } = await postJSON("/embed", { texts });
  if (!ok || !data?.vectors) {
    mlxAvailable = false;
    return null;
  }

  return data.vectors.map((v: number[]) => new Float32Array(v));
}

/**
 * Reset availability cache (e.g., after starting the server).
 */
export function resetMlxCache(): void {
  mlxAvailable = null;
  lastCheck = 0;
}

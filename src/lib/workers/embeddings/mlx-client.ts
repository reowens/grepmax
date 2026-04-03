/**
 * MLX embedding server HTTP client.
 * Tries the local MLX GPU server for dense embeddings.
 * Returns null if the server isn't running — caller falls back to ONNX.
 */

import * as http from "node:http";
import { debug } from "../../utils/logger";

const MLX_PORT = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
const MLX_HOST = "127.0.0.1";
const MLX_TIMEOUT_MS = 10_000;
const EMBED_MODE = process.env.GMAX_EMBED_MODE || "auto";

let mlxAvailable: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 30_000;
let lastMlxWarning = 0;
const MLX_WARNING_INTERVAL_MS = 60_000;

function postJSON(
  reqPath: string,
  body: unknown,
): Promise<{ ok: boolean; data?: any }> {
  const start = performance.now();
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: MLX_HOST,
        port: MLX_PORT,
        path: reqPath,
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
            const ok = res.statusCode === 200;
            debug("mlx", `POST ${reqPath} → ${res.statusCode} ${(performance.now() - start).toFixed(0)}ms payload=${payload.length}B`);
            resolve({ ok, data });
          } catch {
            debug("mlx", `POST ${reqPath} → parse error ${(performance.now() - start).toFixed(0)}ms`);
            resolve({ ok: false });
          }
        });
      },
    );
    req.on("error", (err) => {
      debug("mlx", `POST ${reqPath} → error: ${err.message} ${(performance.now() - start).toFixed(0)}ms`);
      resolve({ ok: false });
    });
    req.on("timeout", () => {
      debug("mlx", `POST ${reqPath} → timeout after ${MLX_TIMEOUT_MS}ms`);
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
async function checkHealth(): Promise<boolean> {
  const start = performance.now();
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { hostname: MLX_HOST, port: MLX_PORT, path: "/health", timeout: 2000 },
      (res) => {
        res.resume();
        const ok = res.statusCode === 200;
        debug("mlx", `health → ${ok ? "ok" : `status=${res.statusCode}`} ${(performance.now() - start).toFixed(0)}ms`);
        resolve(ok);
      },
    );
    req.on("error", (err) => {
      debug("mlx", `health → error: ${err.message} ${(performance.now() - start).toFixed(0)}ms`);
      resolve(false);
    });
    req.on("timeout", () => {
      debug("mlx", `health → timeout ${(performance.now() - start).toFixed(0)}ms`);
      req.destroy();
      resolve(false);
    });
  });
}

export async function isMlxUp(): Promise<boolean> {
  const now = Date.now();
  if (mlxAvailable !== null && now - lastCheck < CHECK_INTERVAL_MS) {
    debug("mlx", `isMlxUp cached=${mlxAvailable} age=${now - lastCheck}ms`);
    return mlxAvailable;
  }

  let result = await checkHealth();

  // On first check (cold start), retry once after 3s — server may still be loading
  if (!result && mlxAvailable === null) {
    console.log("[mlx] Embed server not ready, retrying in 3s...");
    await new Promise((r) => setTimeout(r, 3000));
    result = await checkHealth();
    if (result) {
      console.log("[mlx] Embed server ready");
    } else {
      console.warn("[mlx] Embed server not available after retry");
    }
  }

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
  debug("mlx", `embed ${texts.length} texts`);

  let postResult: { ok: boolean; data?: any };
  try {
    postResult = await postJSON("/embed", { texts });
  } catch (error: any) {
    mlxAvailable = false;
    const now = Date.now();
    if (now - lastMlxWarning >= MLX_WARNING_INTERVAL_MS) {
      console.error("[mlx] Embed server failed:", error.message || error);
      lastMlxWarning = now;
    }
    return null;
  }
  const { ok, data } = postResult;
  if (!ok || !data?.vectors) {
    const wasPreviouslyAvailable = mlxAvailable !== false;
    mlxAvailable = false;
    const now = Date.now();
    if (wasPreviouslyAvailable || now - lastMlxWarning >= MLX_WARNING_INTERVAL_MS) {
      console.error("[mlx] Embed server failed: bad response (ok=" + ok + ", hasVectors=" + !!data?.vectors + ")");
      lastMlxWarning = now;
    }
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

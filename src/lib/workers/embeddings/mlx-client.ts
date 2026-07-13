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
const FLOAT32_MAX = 3.4028234663852886e38;

let mlxAvailable: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 30_000;
let lastMlxWarning = 0;
const MLX_WARNING_INTERVAL_MS = 60_000;
let checkedModel: string | undefined;

export interface MlxEmbeddingOptions {
  mode: "cpu" | "gpu";
  expectedModel: string;
  expectedDim: number;
}

interface MlxEmbeddingResponse {
  vectors: number[][];
  dim: number;
  model: string;
}

export function validateMlxEmbeddingResponse(
  data: unknown,
  textCount: number,
  expectedModel?: string,
  expectedDim?: number,
): data is MlxEmbeddingResponse {
  if (!data || typeof data !== "object") return false;
  const response = data as Partial<MlxEmbeddingResponse>;
  return (
    typeof response.model === "string" &&
    (!expectedModel || response.model === expectedModel) &&
    typeof response.dim === "number" &&
    Number.isInteger(response.dim) &&
    (expectedDim === undefined || response.dim === expectedDim) &&
    Array.isArray(response.vectors) &&
    response.vectors.length === textCount &&
    response.vectors.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === response.dim &&
        (expectedDim === undefined || vector.length === expectedDim) &&
        vector.every(
          (element) =>
            typeof element === "number" &&
            Number.isFinite(element) &&
            Math.abs(element) <= FLOAT32_MAX,
        ),
    )
  );
}

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
            debug(
              "mlx",
              `POST ${reqPath} → ${res.statusCode} ${(performance.now() - start).toFixed(0)}ms payload=${payload.length}B`,
            );
            resolve({ ok, data });
          } catch {
            debug(
              "mlx",
              `POST ${reqPath} → parse error ${(performance.now() - start).toFixed(0)}ms`,
            );
            resolve({ ok: false });
          }
        });
      },
    );
    req.on("error", (err) => {
      debug(
        "mlx",
        `POST ${reqPath} → error: ${err.message} ${(performance.now() - start).toFixed(0)}ms`,
      );
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
async function checkHealth(expectedModel?: string): Promise<boolean> {
  const start = performance.now();
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { hostname: MLX_HOST, port: MLX_PORT, path: "/health", timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let model: unknown;
          try {
            model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
          } catch {}
          const ok =
            res.statusCode === 200 &&
            (!expectedModel || model === expectedModel);
          debug(
            "mlx",
            `health → ${ok ? "ok" : `status=${res.statusCode} model=${String(model)}`} ${(performance.now() - start).toFixed(0)}ms`,
          );
          resolve(ok);
        });
      },
    );
    req.on("error", (err) => {
      debug(
        "mlx",
        `health → error: ${err.message} ${(performance.now() - start).toFixed(0)}ms`,
      );
      resolve(false);
    });
    req.on("timeout", () => {
      debug(
        "mlx",
        `health → timeout ${(performance.now() - start).toFixed(0)}ms`,
      );
      req.destroy();
      resolve(false);
    });
  });
}

export async function isMlxUp(expectedModel?: string): Promise<boolean> {
  const now = Date.now();
  if (
    checkedModel === expectedModel &&
    mlxAvailable !== null &&
    now - lastCheck < CHECK_INTERVAL_MS
  ) {
    debug("mlx", `isMlxUp cached=${mlxAvailable} age=${now - lastCheck}ms`);
    return mlxAvailable;
  }

  let result = await checkHealth(expectedModel);

  // On first check (cold start), retry once after 3s — server may still be loading
  if (!result && mlxAvailable === null) {
    console.log("[mlx] Embed server not ready, retrying in 3s...");
    await new Promise((r) => setTimeout(r, 3000));
    result = await checkHealth(expectedModel);
    if (result) {
      console.log("[mlx] Embed server ready");
    } else {
      console.warn("[mlx] Embed server not available after retry");
    }
  }

  mlxAvailable = result;
  checkedModel = expectedModel;
  lastCheck = now;
  return result;
}

/**
 * Get dense embeddings from MLX server.
 * Returns Float32Array[] on success, null if server unavailable.
 */
export async function mlxEmbed(
  texts: string[],
  options?: MlxEmbeddingOptions,
): Promise<Float32Array[] | null> {
  const mode = options?.mode ?? EMBED_MODE;
  if (mode === "cpu") return null;
  if (!(await isMlxUp(options?.expectedModel))) return null;
  debug("mlx", `embed ${texts.length} texts`);

  let postResult: { ok: boolean; data?: any };
  try {
    postResult = await postJSON("/embed", {
      texts,
      expected_model: options?.expectedModel,
    });
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
  const responseMatches = validateMlxEmbeddingResponse(
    data,
    texts.length,
    options?.expectedModel,
    options?.expectedDim,
  );
  if (!ok || !responseMatches) {
    const wasPreviouslyAvailable = mlxAvailable !== false;
    mlxAvailable = false;
    const now = Date.now();
    if (
      wasPreviouslyAvailable ||
      now - lastMlxWarning >= MLX_WARNING_INTERVAL_MS
    ) {
      console.error(
        "[mlx] Embed server failed: bad response (ok=" +
          ok +
          ", validResponse=" +
          responseMatches +
          ", dim=" +
          String(data?.dim) +
          ", model=" +
          String(data?.model) +
          ")",
      );
      lastMlxWarning = now;
    }
    return null;
  }

  return data.vectors.map((v) => new Float32Array(v));
}

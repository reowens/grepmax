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

export interface MlxHttpResult {
  ok: boolean;
  data?: any;
  category?: "transport" | "timeout" | "http" | "protocol";
  status?: number;
  detail?: string;
  ms: number;
}

/** A hard deadline also bounds stalled/truncated response bodies. */
export function requestMlxJSON(
  reqPath: string,
  body?: unknown,
): Promise<MlxHttpResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Omit<MlxHttpResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, ms: Math.round(performance.now() - start) });
    };
    const req = http.request(
      {
        hostname: MLX_HOST,
        port: MLX_PORT,
        path: reqPath,
        method: payload === undefined ? "GET" : "POST",
        headers:
          payload === undefined
            ? undefined
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            finish({
              ok: false,
              category: "protocol",
              status: res.statusCode,
              detail: "response exceeds 16MiB",
            });
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on("aborted", () =>
          finish({
            ok: false,
            category: "transport",
            status: res.statusCode,
            detail: "response aborted",
          }),
        );
        res.on("error", (err: Error) =>
          finish({
            ok: false,
            category: "transport",
            status: res.statusCode,
            detail: err.message.slice(0, 512),
          }),
        );
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            finish({
              ok: false,
              category: "http",
              status: res.statusCode,
              detail: raw.slice(0, 512),
            });
            return;
          }
          try {
            finish({ ok: true, status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            finish({
              ok: false,
              category: "protocol",
              status: res.statusCode,
              detail: "invalid JSON",
            });
          }
        });
      },
    );
    req.on("error", (err: Error) =>
      finish({
        ok: false,
        category: "transport",
        detail: err.message.slice(0, 512),
      }),
    );
    deadline = setTimeout(
      () => {
        finish({
          ok: false,
          category: "timeout",
          detail: "request deadline exceeded",
        });
        req.destroy();
      },
      reqPath === "/health" ? 2000 : MLX_TIMEOUT_MS,
    );
    req.end(payload);
  });
}

async function checkHealth(expectedModel?: string): Promise<boolean> {
  const result = await requestMlxJSON("/health");
  const ok =
    result.ok && (!expectedModel || result.data?.model === expectedModel);
  debug(
    "mlx",
    `health ok=${ok} category=${result.category ?? "none"} status=${result.status ?? "none"} ms=${result.ms}`,
  );
  return ok;
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

  let postResult: MlxHttpResult;
  try {
    postResult = await requestMlxJSON("/embed", {
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
        `[mlx] Embed failed: category=${postResult.category ?? "protocol"} status=${postResult.status ?? "none"} ms=${postResult.ms} batch=${texts.length} detail=${JSON.stringify(postResult.detail ?? `invalid vectors/model: dim=${String(data?.dim)} model=${String(data?.model)}`).slice(0, 600)}`,
      );
      lastMlxWarning = now;
    }
    if (
      (postResult.ok && !responseMatches) ||
      postResult.category === "protocol" ||
      (postResult.category === "http" &&
        (postResult.status ?? 500) < 500 &&
        postResult.status !== 429 &&
        postResult.status !== 408)
    ) {
      throw new Error(
        `MLX embedding protocol failure: status=${postResult.status ?? "none"} ${postResult.detail ?? "invalid vectors or model identity"}`,
      );
    }
    return null;
  }

  return data.vectors.map((v) => new Float32Array(v));
}

/** Cached positive identity permits one bounded call to the existing backend.
 * Every response verifies model/dimensions again; no polling or startup follows
 * from an idle cache. A failed call revokes eligibility until external work
 * confirms readiness again.
 */
export function isMlxExistingReady(expectedModel: string): boolean {
  return mlxAvailable === true && checkedModel === expectedModel;
}
export async function mlxEmbedExisting(
  texts: string[],
  options: MlxEmbeddingOptions,
): Promise<Float32Array[]> {
  if (!isMlxExistingReady(options.expectedModel))
    throw new Error("embedding_unavailable");
  const result = await requestMlxJSON("/embed", {
    texts,
    expected_model: options.expectedModel,
  });
  if (
    !result.ok ||
    !validateMlxEmbeddingResponse(
      result.data,
      texts.length,
      options.expectedModel,
      options.expectedDim,
    )
  ) {
    mlxAvailable = false;
    throw new Error("embedding_unavailable");
  }
  lastCheck = Date.now();
  return result.data.vectors.map((v: number[]) => new Float32Array(v));
}

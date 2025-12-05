import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import { MODEL_IDS } from "../../config";

// Configuration
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Suppress noisy warnings from transformers.js/onnxruntime
const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    args[0] &&
    typeof args[0] === "string" &&
    args[0].includes("Unable to determine content-length")
  ) {
    return;
  }
  originalWarn(...args);
};

type QuantizationDType =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

type PipelineDType = QuantizationDType | Record<string, QuantizationDType>;

// Helper to download with timeout
async function downloadModelWithTimeout(modelId: string, dtype: PipelineDType) {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const downloadPromise = pipeline("feature-extraction", modelId, {
      dtype,
      progress_callback: (progress: unknown) => {
        if (parentPort) parentPort.postMessage({ type: "progress", progress });
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Download timed out after ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      );
    });

    return Promise.race([downloadPromise, timeoutPromise]);
  } catch (err) {
    console.error(`Worker: pipeline creation failed for ${modelId}: `, err);
    throw err;
  }
}

// Helper to manually download extra files like skiplist.json
async function downloadExtraFile(modelId: string, filename: string) {
  const url = `https://huggingface.co/${modelId}/resolve/main/${filename}`;
  // Construct path: ~/.osgrep/models/ryandono/osgrep-colbert-q8/skiplist.json
  const destDir = path.join(CACHE_DIR, ...modelId.split("/"));
  const destPath = path.join(destDir, filename);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // If file exists and is non-zero, skip (or implement hash check if you want SOTA robustness)
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return;
  }

  if (parentPort) {
    parentPort.postMessage({
      type: "progress",
      progress: { status: "downloading", file: filename },
    });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
  } catch (e) {
    console.warn(`⚠️ Failed to download ${filename}:`, e);
    // Don't crash, just warn. The math worker has a fallback (empty set).
  }
}

async function download() {
  try {
    // 1. Download Dense Model
    const embedPipeline = await downloadModelWithTimeout(MODEL_IDS.embed, "q4");
    await embedPipeline.dispose();

    // 2. Download ColBERT Model
    const colbertPipeline = await downloadModelWithTimeout(
      MODEL_IDS.colbert,
      "fp32",
    );
    await colbertPipeline.dispose();

    // 3. Download the custom Skiplist
    await downloadExtraFile(MODEL_IDS.colbert, "skiplist.json");

    if (parentPort) {
      parentPort.postMessage({ status: "success" });
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error("Worker failed to download models:", error);
    if (parentPort) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      parentPort.postMessage({ status: "error", error: errorMsg });
    } else {
      process.exit(1);
    }
  }
}

download();

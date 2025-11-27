
import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import * as path from "node:path";
import * as os from "node:os";
import { MODEL_IDS } from "../config";

// Configuration
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

async function download() {
    try {
        // 1. Download Dense Model
        const embedPipeline = await pipeline("feature-extraction", MODEL_IDS.embed, {
            dtype: "q4",
        });
        await embedPipeline.dispose();

        // 2. Download ColBERT Model
        const colbertPipeline = await pipeline("feature-extraction", MODEL_IDS.colbert, {
            dtype: "q8",
        });
        await colbertPipeline.dispose();

        if (parentPort) {
            parentPort.postMessage({ status: "success" });
        } else {
            process.exit(0);
        }
    } catch (error) {
        console.error("Worker failed to download models:", error);
        if (parentPort) {
            parentPort.postMessage({ status: "error", error });
        } else {
            process.exit(1);
        }
    }
}

download();

import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import * as path from "node:path";
import * as os from "node:os";

// Configure cache directory
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
// We start with false to prefer local, but will toggle if needed
env.allowRemoteModels = false;

class EmbeddingWorker {
    private pipe: any = null;
    private modelId = "mixedbread-ai/mxbai-embed-xsmall-v1";

    async initialize() {
        if (this.pipe) return;

        console.log(`Worker: Loading model from ${CACHE_DIR}...`);

        try {
            this.pipe = await pipeline("feature-extraction", this.modelId, {
                dtype: "q8",
            });
        } catch (error) {
            console.log("Worker: Local model not found. Downloading...");
            env.allowRemoteModels = true;
            this.pipe = await pipeline("feature-extraction", this.modelId, {
                dtype: "q8",
            });
            // Revert to offline-only after download
            env.allowRemoteModels = false;
        }

        console.log("Worker: Model loaded.");
    }

    async embed(texts: string[]): Promise<number[][]> {
        if (!this.pipe) await this.initialize();

        const output = await this.pipe(texts, {
            pooling: "cls",
            normalize: true,
            truncation: true,
            max_length: 512,
        });

        // Handle both single and batch outputs
        const embeddings: number[][] = [];
        const dims = output.dims || [1, output.data.length];
        const [batchSize, hiddenSize] = dims.length === 2 ? dims : [1, dims[0]];

        for (let i = 0; i < batchSize; i++) {
            const start = i * hiddenSize;
            // Matryoshka slicing: take first 128 dimensions
            // The model outputs 384, we want first 128.
            const vec = output.data.slice(start, start + 128);
            embeddings.push(Array.from(vec));
        }

        return embeddings;
    }
}

const worker = new EmbeddingWorker();

if (parentPort) {
    parentPort.on("message", async (message: { id: string; text?: string; texts?: string[] }) => {
        try {
            const inputs = message.texts || (message.text ? [message.text] : []);
            if (inputs.length === 0) {
                throw new Error("No text provided");
            }

            const vectors = await worker.embed(inputs);
            const memory = process.memoryUsage();

            // If original request was single text, return single vector (for backward compat if needed)
            // But better to return consistent format. 
            // However, the caller expects `vector` (singular) for the old `text` (singular) request.
            // We'll adapt the response based on input.

            if (message.text && !message.texts) {
                parentPort?.postMessage({ id: message.id, vector: vectors[0], memory });
            } else {
                parentPort?.postMessage({ id: message.id, vectors, memory });
            }

        } catch (error) {
            console.error("Worker error:", error);
            parentPort?.postMessage({
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

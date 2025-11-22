import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

// Skip local model checks for now to allow download
env.allowLocalModels = false;
env.useBrowserCache = false;

class EmbeddingWorker {
    private pipe: any = null;
    private modelId = "mixedbread-ai/mxbai-embed-xsmall-v1";

    async initialize() {
        if (this.pipe) return;

        console.log("Worker: Loading model...");
        this.pipe = await pipeline("feature-extraction", this.modelId, {
            dtype: "q8",
        });
        console.log("Worker: Model loaded.");
    }

    async embed(text: string): Promise<number[]> {
        if (!this.pipe) await this.initialize();

        const output = await this.pipe(text, { pooling: "cls", normalize: true });
        const embedding = Array.from(output.data) as number[];

        // Matryoshka slicing: take first 128 dimensions
        return embedding.slice(0, 128);
    }
}

const worker = new EmbeddingWorker();

if (parentPort) {
    parentPort.on("message", async (message: { id: string; text: string }) => {
        try {
            const vector = await worker.embed(message.text);
            parentPort?.postMessage({ id: message.id, vector });
        } catch (error) {
            console.error("Worker error:", error);
            parentPort?.postMessage({
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

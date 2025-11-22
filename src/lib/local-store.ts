import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as lancedb from "@lancedb/lancedb";
import { v4 as uuidv4 } from "uuid";
import type {
    AskResponse,
    ChunkType,
    CreateStoreOptions,
    SearchFilter,
    SearchResponse,
    Store,
    StoreFile,
    StoreInfo,
    UploadFileOptions,
} from "./store";

const DB_PATH = path.join(os.homedir(), ".osgrep", "data");

interface VectorRecord {
    id: string;
    path: string;
    hash: string;
    content: string;
    start_line: number;
    end_line: number;
    vector: number[];
    [key: string]: any;
}

import { TreeSitterChunker } from "./chunker";

export class LocalStore implements Store {
    private db: lancedb.Connection | null = null;
    private worker!: Worker;
    private pendingRequests = new Map<
        string,
        { resolve: (v: number[] | number[][]) => void; reject: (e: any) => void }
    >();
    private readonly MAX_WORKER_RSS = 1.5 * 1024 * 1024 * 1024; // restart only when truly high to avoid churn
    private embedQueue: Promise<void> = Promise.resolve();
    private chunker = new TreeSitterChunker();
    private readonly VECTOR_DIMENSIONS = 512;
    private readonly queryPrefix =
        "Represent this sentence for searching relevant passages: ";

    constructor() {
        this.initializeWorker();
        // Initialize chunker in background (it might download WASMs)
        this.chunker.init().catch(err => console.error("Failed to init chunker:", err));
    }

    private getWorkerConfig(): { workerPath: string; execArgv: string[] } {
        const tsWorkerPath = path.join(__dirname, "worker.ts");
        const jsWorkerPath = path.join(__dirname, "worker.js");
        const hasTsWorker = fs.existsSync(tsWorkerPath);
        const hasJsWorker = fs.existsSync(jsWorkerPath);
        const runningTs = path.extname(__filename) === ".ts";
        const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

        if (isDev) {
            return { workerPath: tsWorkerPath, execArgv: ["-r", "ts-node/register"] };
        }
        return { workerPath: jsWorkerPath, execArgv: [] };
    }

    private initializeWorker() {
        const { workerPath, execArgv } = this.getWorkerConfig();
        this.worker = new Worker(workerPath, { execArgv });
        this.worker.on("message", (message) => {
            const { id, vector, vectors, scores, error, memory } = message;
            const pending = this.pendingRequests.get(id);

            if (pending) {
                if (error) {
                    pending.reject(new Error(error));
                } else if (vectors !== undefined) {
                    pending.resolve(vectors);
                } else if (scores !== undefined) {
                    pending.resolve(scores);
                } else {
                    pending.resolve(vector);
                }
                this.pendingRequests.delete(id);
            }

            if (memory && memory.rss > this.MAX_WORKER_RSS) {
                console.warn(`Worker memory usage high (${Math.round(memory.rss / 1024 / 1024)}MB). Restarting...`);
                this.restartWorker();
            }
        });
    }

    private async restartWorker() {
        // Reject anything still waiting on the old worker
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        for (const { reject } of pending) {
            reject(new Error("Worker restarted"));
        }

        await this.worker.terminate();
        this.initializeWorker();
    }

    private async enqueueEmbedding<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.embedQueue.then(fn, fn);
        // Ensure queue advances even if fn rejects
        this.embedQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async getEmbeddings(texts: string[]): Promise<number[][]> {
        return this.enqueueEmbedding(
            () =>
                new Promise((resolve, reject) => {
                    const id = uuidv4();
                    this.pendingRequests.set(id, { resolve: resolve as any, reject });
                    this.worker.postMessage({ id, texts });
                }),
        );
    }

    private async getEmbedding(text: string): Promise<number[]> {
        // Wrapper for single text to maintain compatibility where needed
        const results = await this.getEmbeddings([text]);
        return results[0];
    }

    private async rerankDocuments(query: string, documents: string[]): Promise<number[]> {
        return this.enqueueEmbedding(
            () =>
                new Promise((resolve, reject) => {
                    const id = uuidv4();
                    this.pendingRequests.set(id, { resolve: resolve as any, reject });
                    this.worker.postMessage({ id, rerank: { query, documents } });
                }),
        ) as Promise<number[]>;
    }

    private async getDb(): Promise<lancedb.Connection> {
        if (!this.db) {
            if (!fs.existsSync(DB_PATH)) {
                fs.mkdirSync(DB_PATH, { recursive: true });
            }
            this.db = await lancedb.connect(DB_PATH);
        }
        return this.db;
    }

    private async getTable(storeId: string): Promise<lancedb.Table> {
        const db = await this.getDb();
        return await db.openTable(storeId);
    }

    private baseSchemaRow(): VectorRecord {
        return {
            id: "seed",
            path: "",
            hash: "",
            content: "",
            start_line: 0,
            end_line: 0,
            vector: Array(this.VECTOR_DIMENSIONS).fill(0),
        };
    }

    private async ensureTable(storeId: string): Promise<lancedb.Table> {
        const db = await this.getDb();
        try {
            return await db.openTable(storeId);
        } catch {
            const table = await db.createTable(storeId, [this.baseSchemaRow()]);
            await table.delete('id = "seed"');
            return table;
        }
    }

    async *listFiles(storeId: string): AsyncGenerator<StoreFile> {
        try {
            const table = await this.getTable(storeId);
            // This is a simplification; ideally we'd group by file path
            // For now, let's just return unique paths
            const results = await table
                .query()
                .select(["path", "hash"])
                .toArray();

            const seen = new Set<string>();
            for (const r of results) {
                if (!seen.has(r.path as string)) {
                    seen.add(r.path as string);
                    yield {
                        external_id: r.path as string,
                        metadata: { path: r.path as string, hash: (r.hash as string) || "" },
                    };
                }
            }
        } catch (e) {
            // Table might not exist
        }
    }

    async uploadFile(
        storeId: string,
        file: File | ReadableStream | any,
        options: UploadFileOptions,
    ): Promise<void> {
        const table = await this.ensureTable(storeId);

        // Read file content (prefer provided content to avoid double reads)
        let content = options.content ?? "";
        if (!content) {
            if (typeof file === "string") {
                content = file;
            } else if (file && typeof file.read === "function") {
                // It's a stream
                for await (const chunk of file) {
                    content += chunk;
                }
            } else if (file instanceof File) {
                content = await file.text();
            } else {
                // Fallback for now
                return;
            }
        }

        // Delete existing chunks for this file
        const safePath = options.metadata?.path?.replace(/'/g, "''");
        if (safePath) {
            await table.delete(`path = '${safePath}'`);
        }

        // Use TreeSitterChunker
        const chunks = await this.chunker.chunk(options.metadata?.path || "unknown", content);
        if (chunks.length === 0) return;

        const texts = chunks.map(c => c.content);

        const BATCH_SIZE = 16;
        const WRITE_BATCH_SIZE = 50;
        let pendingWrites: VectorRecord[] = [];

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batchTexts = texts.slice(i, i + BATCH_SIZE);
            const batchVectors = await this.getEmbeddings(batchTexts);
            for (let j = 0; j < batchVectors.length; j++) {
                const chunkIndex = i + j;
                const chunk = chunks[chunkIndex];
                const vector = batchVectors[j];

                pendingWrites.push({
                    id: uuidv4(),
                    path: options.metadata?.path || "",
                    hash: options.metadata?.hash || "",
                    content: chunk.content,
                    start_line: chunk.startLine,
                    end_line: chunk.endLine,
                    vector,
                });

                if (pendingWrites.length >= WRITE_BATCH_SIZE) {
                    await table.add(pendingWrites);
                    pendingWrites = [];
                }
            }
        }

        if (pendingWrites.length > 0) {
            await table.add(pendingWrites);
        }
    }

    async createFTSIndex(storeId: string): Promise<void> {
        const table = await this.getTable(storeId);
        try {
            await table.createIndex("content");
        } catch (e) {
            console.warn("Failed to create FTS index (might already exist):", e);
        }
    }

    async createVectorIndex(storeId: string): Promise<void> {
        const table = await this.getTable(storeId);
        try {
            await table.createIndex("vector", { type: "ivf_flat" } as any);
        } catch (e) {
            const fallbackMsg = e instanceof Error ? e.message : String(e);
            if (!fallbackMsg.includes("already exists")) {
                try {
                    await table.createIndex("vector");
                } catch (fallbackError) {
                    const fallbackErr = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                    if (!fallbackErr.includes("already exists")) {
                        console.warn("Failed to create vector index:", fallbackError);
                    }
                }
            }
        }
    }

    async search(
        storeId: string,
        query: string,
        top_k?: number,
        _search_options?: { rerank?: boolean },
        _filters?: SearchFilter,
    ): Promise<SearchResponse> {
        let table: lancedb.Table;
        try {
            table = await this.getTable(storeId);
        } catch {
            return { data: [] };
        }
        const queryVector = await this.getEmbedding(this.queryPrefix + query);
        const limit = 50; // fetch more candidates for reranking
        const finalLimit = top_k ?? 10;
        const pathFilter =
            (_filters as any)?.all?.find(
                (f: any) => f?.key === "path" && f?.operator === "starts_with",
            )?.value ?? "";
        const matchesFilter = (r: any) => {
            if (!pathFilter) return true;
            return typeof r.path === "string" && r.path.startsWith(pathFilter);
        };

        const vectorResults = (await table
            .search(queryVector)
            .limit(limit)
            .toArray()).filter(matchesFilter);

        if (vectorResults.length === 0) {
            return { data: [] };
        }

        let rerankScores: number[] | null = null;
        try {
            const docs = vectorResults.map((r) => String(r.content ?? ""));
            rerankScores = await this.rerankDocuments(query, docs);
        } catch (e) {
            console.warn("Reranker failed; falling back to vector order:", e);
        }

        const scoredResults = vectorResults.map((r, i) => ({
            record: r,
            score: rerankScores?.[i] ?? (limit - i) / limit,
        }));

        scoredResults.sort((a, b) => b.score - a.score);

        const limited = scoredResults.slice(0, finalLimit);

        const chunks: ChunkType[] = limited.map(({ record, score }) => ({
            type: "text",
            text: record.content as string,
            score,
            metadata: { path: record.path as string, hash: (record.hash as string) || "" },
            generated_metadata: {
                start_line: record.start_line as number,
                num_lines: (record.end_line as number) - (record.start_line as number),
            },
        }));

        return { data: chunks };
    }

    async retrieve(storeId: string): Promise<unknown> {
        const table = await this.getTable(storeId);
        return typeof (table as any).info === "function" ? (table as any).info?.() : true;
    }

    async create(options: CreateStoreOptions): Promise<unknown> {
        const table = await this.ensureTable(options.name);
        return typeof (table as any).info === "function" ? (table as any).info?.() : true;
    }

    async deleteFile(storeId: string, filePath: string): Promise<void> {
        const table = await this.getTable(storeId);
        const safePath = filePath.replace(/'/g, "''");
        await table.delete(`path = '${safePath}'`);
    }

    async ask(
        storeId: string,
        question: string,
        top_k?: number,
        _search_options?: { rerank?: boolean },
        _filters?: SearchFilter,
    ): Promise<AskResponse> {
        // Basic RAG implementation
        const searchRes = await this.search(storeId, question, top_k);
        const context = searchRes.data.map((c) => c.text).join("\n\n");

        // For now, just return the context as the answer since we don't have an LLM connected yet
        return {
            answer: "I found the following relevant code:\n\n" + context,
            sources: searchRes.data,
        };
    }

    async getInfo(storeId: string): Promise<StoreInfo> {
        return {
            name: storeId,
            description: "Local Store",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            counts: {
                pending: 0,
                in_progress: 0,
            },
        };
    }
}

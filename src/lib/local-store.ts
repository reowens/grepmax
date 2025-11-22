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
    content: string;
    start_line: number;
    end_line: number;
    vector: number[];
    [key: string]: any;
}

export class LocalStore implements Store {
    private db: lancedb.Connection | null = null;
    private worker: Worker;
    private pendingRequests = new Map<
        string,
        { resolve: (v: number[]) => void; reject: (e: any) => void }
    >();

    constructor() {
        this.worker = new Worker(path.join(__dirname, "worker.js"));
        this.worker.on("message", (message) => {
            const { id, vector, error } = message;
            const pending = this.pendingRequests.get(id);
            if (pending) {
                if (error) pending.reject(new Error(error));
                else pending.resolve(vector);
                this.pendingRequests.delete(id);
            }
        });
    }

    private async getEmbedding(text: string): Promise<number[]> {
        return new Promise((resolve, reject) => {
            const id = uuidv4();
            this.pendingRequests.set(id, { resolve, reject });
            this.worker.postMessage({ id, text });
        });
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

    async *listFiles(storeId: string): AsyncGenerator<StoreFile> {
        try {
            const table = await this.getTable(storeId);
            // This is a simplification; ideally we'd group by file path
            // For now, let's just return unique paths
            const results = await table
                .query()
                .select(["path"])
                .limit(10000) // TODO: pagination
                .toArray();

            const seen = new Set<string>();
            for (const r of results) {
                if (!seen.has(r.path as string)) {
                    seen.add(r.path as string);
                    yield {
                        external_id: r.path as string,
                        metadata: { path: r.path as string, hash: "" }, // Hash not stored yet
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
        const db = await this.getDb();
        let table: lancedb.Table;
        try {
            table = await db.openTable(storeId);
        } catch {
            // Create table if not exists
            // 128 dim vector
            table = await db.createTable(storeId, [
                {
                    id: "test",
                    path: "test",
                    content: "test",
                    start_line: 0,
                    end_line: 0,
                    vector: Array(128).fill(0),
                },
            ]);
            await table.delete('id = "test"');
        }

        // Read file content
        // Assuming 'file' is a stream or similar, but for now let's handle the case where it's passed from utils.ts
        // In utils.ts we see: fs.createReadStream(filePath)
        // We need to read the stream to string.
        let content = "";
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

        // Delete existing chunks for this file
        await table.delete(`path = '${options.metadata?.path}'`);

        // Chunking (Simple paragraph split for now)
        const paragraphs = content.split(/\n\s*\n/);
        const data: VectorRecord[] = [];
        let lineOffset = 0;

        for (const p of paragraphs) {
            if (!p.trim()) {
                lineOffset += p.split("\n").length;
                continue;
            }

            const vector = await this.getEmbedding(p);
            const numLines = p.split("\n").length;

            data.push({
                id: uuidv4(),
                path: options.metadata?.path || "",
                content: p,
                start_line: lineOffset,
                end_line: lineOffset + numLines,
                vector,
            });

            lineOffset += numLines;
        }

        if (data.length > 0) {
            await table.add(data);
        }
    }

    async search(
        storeId: string,
        query: string,
        top_k?: number,
        _search_options?: { rerank?: boolean },
        _filters?: SearchFilter,
    ): Promise<SearchResponse> {
        const table = await this.getTable(storeId);
        const queryVector = await this.getEmbedding(query);

        const results = await table
            .search(queryVector)
            .limit(top_k || 10)
            .toArray();

        const chunks: ChunkType[] = results.map((r) => ({
            type: "text",
            text: r.content as string,
            score: 1 - (r._distance as number), // Convert distance to similarity score
            metadata: { path: r.path as string, hash: "" },
            generated_metadata: {
                start_line: r.start_line as number,
                num_lines: (r.end_line as number) - (r.start_line as number),
            },
        }));

        return { data: chunks };
    }

    async retrieve(_storeId: string): Promise<unknown> {
        return {};
    }

    async create(_options: CreateStoreOptions): Promise<unknown> {
        return {};
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

import { fixedWorkerTransport } from "./fixed-transport";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../../config";
import { EmbeddingBackendUnavailableError } from "../embedding-error";
import type { ProcessFileResult } from "../orchestrator";
import { embeddingInputDigest, validatePreparedEmbeddingIdentity, validateRemoteEmbeddingRequest, validateRemoteEmbeddingResult, type PreparedEmbeddingIdentity, type RemoteEmbeddingRequest } from "./protocol";

export interface BackgroundEmbeddingConfig {
  mode: "local" | "remote";
  worker?: string;
  runtimeCheckout?: string;
  runtimeCommit?: string;
  identity?: PreparedEmbeddingIdentity;
}
export function parseBackgroundEmbeddingConfig(value: unknown): BackgroundEmbeddingConfig {
  if (value === undefined) return { mode: "local" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backgroundEmbedding configuration");
  const v = value as BackgroundEmbeddingConfig;
  if (v.mode === "local") return { mode: "local" };
  if (v.mode !== "remote" || typeof v.worker !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(v.worker) || typeof v.runtimeCheckout !== "string" || !path.isAbsolute(v.runtimeCheckout) || typeof v.runtimeCommit !== "string" || !/^[a-f0-9]{40}$/.test(v.runtimeCommit)) throw new Error("Remote background embedding requires named worker and pinned absolute runtime checkout/commit");
  return { mode: "remote", worker: v.worker, runtimeCheckout: v.runtimeCheckout, runtimeCommit: v.runtimeCommit, identity: validatePreparedEmbeddingIdentity(v.identity) };
}
export function readBackgroundEmbeddingConfig(): BackgroundEmbeddingConfig {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(PATHS.globalRoot, "config.json"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid embedding configuration");
    return parseBackgroundEmbeddingConfig((raw as { backgroundEmbedding?: unknown }).backgroundEmbedding);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "local" };
    throw error;
  }
}
export interface RemoteJobIdentity { jobId: string; remoteJobId: string; remoteTaskId?: string }
export interface RemoteEmbeddingTransport {
  /** Trusted installed adapter, never derived from a wire request. */
  capability(config: BackgroundEmbeddingConfig): { available: boolean; reason: string };
  submit(request: RemoteEmbeddingRequest, config: BackgroundEmbeddingConfig, signal: AbortSignal, onIdentity?: (identity: RemoteJobIdentity) => void): Promise<{ result: unknown; terminal: boolean; cleanupConfirmed: boolean; error?: string }>;
}
export class RemoteEmbeddingClient {
  private active = false;
  private readonly settledListeners = new Set<() => void>();
  onSettled(listener: () => void): () => void {
    this.settledListeners.add(listener);
    return () => { this.settledListeners.delete(listener); };
  }
  private blockedReason: string | null = null;
  private readonly epoch = randomUUID();
  constructor(private readonly transport: RemoteEmbeddingTransport = fixedWorkerTransport,
              private readonly custodyPath = path.join(PATHS.globalRoot, "remote-embedding-job.json")) {}
  status(config: BackgroundEmbeddingConfig): { mode: string; state: string; active: boolean; worker?: string; reason?: string } {
    if (config.mode === "local") return { mode: "local", state: "local", active: this.active };
    if (fs.existsSync(this.custodyPath)) return { mode: "remote", worker: config.worker, state: this.active ? "busy" : "unknown", active: this.active, reason: this.active ? "Remote job owns reservation" : "Prior job requires terminal cleanup reconciliation; no resubmission" };
    if (this.blockedReason) return { mode: "remote", worker: config.worker, state: "deferred", active: this.active, reason: this.blockedReason };
    const capability = this.transport.capability(config);
    return { mode: "remote", worker: config.worker, state: this.active ? "busy" : capability.available ? "configured" : "deferred", active: this.active, reason: capability.reason };
  }
  requireAvailable(config: BackgroundEmbeddingConfig) {
    if (config.mode === "local") return;
    const state = this.status(config);
    if (state.state !== "configured") throw new EmbeddingBackendUnavailableError(`Background embedding ${state.state}: ${state.reason ?? "busy"}`);
  }
  async complete(file: ProcessFileResult, config: BackgroundEmbeddingConfig, signal?: AbortSignal): Promise<ProcessFileResult> {
    if (!file.remoteChunks?.length) return file;
    if (config.mode !== "remote" || !config.identity) throw new Error("Remote prepared file has no matching remote route");
    this.requireAvailable(config);
    this.active = true;
    const vectors = file.vectors.map(v => ({ ...v }));
    try {
      for (let offset = 0; offset < file.remoteChunks.length; offset += 16) {
        signal?.throwIfAborted();
        const items = file.remoteChunks.slice(offset, offset+16);
        const chunks = items.map(c => ({ id: String(c.index), text: c.text }));
        const request = validateRemoteEmbeddingRequest({ protocolVersion: 1, jobId: randomUUID(), daemonEpoch: this.epoch, attemptId: randomUUID(), fileRevisionId: file.hash, deadlineAt: Date.now()+180000, identity: config.identity, chunks, inputDigest: embeddingInputDigest(chunks) });
        fs.mkdirSync(path.dirname(this.custodyPath), { recursive: true, mode: 0o700 });
        // Exclusive creation also fences a second controller/daemon. No chunk text is persisted.
        fs.writeFileSync(this.custodyPath, JSON.stringify({ jobId: request.jobId, daemonEpoch: this.epoch, attemptId: request.attemptId, worker: config.worker, deadlineAt: request.deadlineAt }), { flag: "wx", mode: 0o600 });
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => controller.abort(new Error("Remote embedding deadline")), 180000);
        try {
          // Do not race away from native/remote custody on cancellation. The adapter
          // must settle with terminal cleanup evidence; otherwise the record stays.
          const remember = (identity: RemoteJobIdentity) => {
            if (identity.jobId !== request.jobId || !/^[a-f0-9]{32}$/.test(identity.remoteJobId) || (identity.remoteTaskId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(identity.remoteTaskId))) throw new Error("Invalid remote custody identity");
            if (fs.lstatSync(this.custodyPath).size > 8192) throw new Error("Custody record exceeds bound");
            const prior = JSON.parse(fs.readFileSync(this.custodyPath, "utf8")) as Partial<RemoteJobIdentity>;
            if (prior.jobId !== request.jobId) throw new Error("Custody changed before remote admission");
            if ((prior.remoteJobId && prior.remoteJobId !== identity.remoteJobId) || (prior.remoteTaskId && identity.remoteTaskId && prior.remoteTaskId !== identity.remoteTaskId)) throw new Error("Admitted remote custody identity changed");
            const temp = this.custodyPath+"."+request.attemptId;
            fs.writeFileSync(temp, JSON.stringify({ ...prior, ...identity }), { flag: "wx", mode: 0o600 });
            fs.renameSync(temp, this.custodyPath);
          };
          const reply = await this.transport.submit(request, config, controller.signal, remember);
          if (!reply.terminal || !reply.cleanupConfirmed) throw new Error("Remote job cleanup unknown");
          if (fs.lstatSync(this.custodyPath).size > 8192) throw new Error("Remote custody record exceeds bound");
          const custody = JSON.parse(fs.readFileSync(this.custodyPath, "utf8")) as { jobId?: string };
          if (custody.jobId !== request.jobId) throw new Error("Remote custody identity changed");
          fs.unlinkSync(this.custodyPath);
          controller.signal.throwIfAborted();
          if (Date.now() >= request.deadlineAt) throw new Error("Expired remote result");
          if (reply.error) throw new EmbeddingBackendUnavailableError(reply.error);
          const result = validateRemoteEmbeddingResult(reply.result, request);
          result.vectors.forEach((r, i) => {
            const index = items[i].index;
            if (!Number.isInteger(index) || index < 0 || index >= vectors.length) throw new Error("Remote chunk index differs");
            vectors[index] = { ...vectors[index], vector: new Float32Array(r.dense), colbert: Buffer.from(r.colbert, "base64"), colbert_scale: r.scale, pooled_colbert_48d: new Float32Array(r.pooled), doc_token_ids: r.tokenIds };
          });
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
      }
      const { remoteChunks: _remoteChunks, ...completed } = file;
      return { ...completed, vectors };
    } catch (error) {
      if (!signal?.aborted || fs.existsSync(this.custodyPath)) this.blockedReason = error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 300) : "remote_attempt_failed";
      throw new EmbeddingBackendUnavailableError(error instanceof Error ? error.message : "Remote embedding failed");
    } finally {
      this.active = false;
      for (const listener of this.settledListeners) queueMicrotask(() => {
        try { listener(); } catch { console.error("Remote background queue notification failed"); }
      });
    }
  }
}
export const backgroundEmbeddingClient = new RemoteEmbeddingClient();
export function backgroundEmbeddingStatus(expectedFingerprint?: string) {
  try {
    const route = readBackgroundEmbeddingConfig();
    if (route.mode === "remote" && expectedFingerprint && route.identity?.generation.fingerprint !== expectedFingerprint) return { mode: "remote", state: "error", active: false, reason: "Remote generation differs from initialized P3 generation" };
    return backgroundEmbeddingClient.status(route);
  }
  catch (error) { return { mode: "remote", state: "error", reason: error instanceof Error ? error.message : String(error) }; }
}

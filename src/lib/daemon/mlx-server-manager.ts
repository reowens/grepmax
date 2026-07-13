import { type ChildProcess, execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { PATHS } from "../../config";
import { openRotatedLog } from "../utils/log-rotate";
import {
  DEFAULT_MLX_EMBED_MODEL,
  resolveMlxHfHome,
} from "../utils/mlx-hf-cache";
import { terminateProcessGroup } from "../utils/process";

const STARTUP_ATTEMPTS = 30;
const STARTUP_POLL_MS = 1_000;
const MAX_HEALTH_BODY_BYTES = 16 * 1024;

export type MlxLifecycleState =
  | "stopped"
  | "probing"
  | "starting"
  | "owned-ready"
  | "adopted-ready"
  | "stopping"
  | "failed";

export interface MlxManagerStatus {
  enabled: boolean;
  state: MlxLifecycleState;
  port: number;
  model: string;
  pid: number | null;
  lastHealthyAt?: number;
  error?: string;
}

export type MlxHealthResult =
  | { kind: "healthy"; model: string; owner?: string }
  | { kind: "unavailable"; reason: string };

interface OwnedServer {
  kind: "owned";
  child: ChildProcess;
  pid: number;
  model: string;
  owner: string;
  lastHealthyAt: number;
}

interface AdoptedServer {
  kind: "adopted";
  model: string;
  lastHealthyAt: number;
}

type StableServer = OwnedServer | AdoptedServer | { kind: "stopped" };

interface MlxServerManagerDeps {
  getShuttingDown: () => boolean;
  probeHealth?: (port: number) => Promise<MlxHealthResult>;
  getPortPid?: (port: number) => number | null;
  spawn?: typeof spawn;
  openLog?: typeof openRotatedLog;
  closeFd?: typeof fs.closeSync;
  terminateGroup?: typeof terminateProcessGroup;
  sleep?: (ms: number) => Promise<void>;
  createOwnerToken?: () => string;
}

export class MlxServerManager {
  private stable: StableServer = { kind: "stopped" };
  private phase: Exclude<
    MlxLifecycleState,
    "stopped" | "owned-ready" | "adopted-ready"
  > | null = null;
  private enabled = false;
  private desiredModel = DEFAULT_MLX_EMBED_MODEL;
  private ensureFlight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private lastError: string | undefined;

  constructor(private readonly deps: MlxServerManagerDeps) {}

  private get port(): number {
    return Number.parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
  }

  private shouldStop(): boolean {
    return !this.enabled || this.deps.getShuttingDown();
  }

  private sleep(ms: number): Promise<void> {
    return (
      this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
    );
  }

  private async probeHealth(port: number): Promise<MlxHealthResult> {
    if (this.deps.probeHealth) return this.deps.probeHealth(port);
    return new Promise<MlxHealthResult>((resolve) => {
      let settled = false;
      const settle = (result: MlxHealthResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = http.get(
        { hostname: "127.0.0.1", port, path: "/health", timeout: 2_000 },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_HEALTH_BODY_BYTES) {
              req.destroy();
              settle({ kind: "unavailable", reason: "health body too large" });
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              settle({
                kind: "unavailable",
                reason: `health status ${res.statusCode ?? "unknown"}`,
              });
              return;
            }
            try {
              const data = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as Record<string, unknown>;
              if (data.status !== "ok" || typeof data.model !== "string") {
                settle({ kind: "unavailable", reason: "invalid health body" });
                return;
              }
              settle({
                kind: "healthy",
                model: data.model,
                ...(typeof data.owner === "string"
                  ? { owner: data.owner }
                  : {}),
              });
            } catch {
              settle({ kind: "unavailable", reason: "invalid health JSON" });
            }
          });
        },
      );
      req.on("error", (error) =>
        settle({ kind: "unavailable", reason: error.message }),
      );
      req.on("timeout", () => {
        req.destroy();
        settle({ kind: "unavailable", reason: "health timeout" });
      });
    });
  }

  private getPortPid(port: number): number | null {
    if (this.deps.getPortPid) return this.deps.getPortPid(port);
    try {
      const out = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, {
        timeout: 5_000,
      })
        .toString()
        .trim();
      const pid = Number.parseInt(out.split("\n")[0], 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private async terminateOwned(server: OwnedServer): Promise<void> {
    const terminate = this.deps.terminateGroup ?? terminateProcessGroup;
    const stopped = await terminate(server.pid);
    if (!stopped) {
      console.error(
        `[daemon] Failed to fully stop owned MLX process group ${server.pid}`,
      );
    }
    server.child.removeAllListeners("error");
    server.child.removeAllListeners("exit");
    if (this.stable === server) this.stable = { kind: "stopped" };
  }

  private trackOwnedExit(server: OwnedServer): void {
    server.child.on("error", (error) => {
      console.error(
        `[daemon] MLX embed server process error: ${error.message}`,
      );
      if (this.stable === server) {
        this.stable = { kind: "stopped" };
        this.lastError = error.message;
      }
    });
    server.child.on("exit", () => {
      if (this.stable === server) this.stable = { kind: "stopped" };
    });
  }

  async checkMlxHealth(): Promise<void> {
    if (!this.enabled || this.deps.getShuttingDown()) return;
    await this.ensureMlxServer(this.desiredModel);
  }

  async ensureMlxServer(mlxModel?: string): Promise<void> {
    this.enabled = true;
    this.desiredModel = mlxModel ?? this.desiredModel;
    if (this.stopFlight || this.deps.getShuttingDown()) return;
    if (this.ensureFlight) return this.ensureFlight;

    const flight = this.ensureInternal(this.desiredModel).finally(() => {
      if (this.ensureFlight === flight) this.ensureFlight = null;
      if (this.phase === "probing" || this.phase === "starting") {
        this.phase = null;
      }
    });
    this.ensureFlight = flight;
    return flight;
  }

  private async ensureInternal(model: string): Promise<void> {
    this.phase = "probing";
    const health = await this.probeHealth(this.port);
    if (this.shouldStop()) return;

    if (health.kind === "healthy") {
      if (health.model !== model) {
        if (this.stable.kind === "owned") {
          await this.terminateOwned(this.stable);
        }
        this.lastError = `port ${this.port} serves model ${health.model}, expected ${model}`;
        this.phase = "failed";
        console.error(`[daemon] MLX ${this.lastError}; leaving it untouched`);
        return;
      }
      if (this.stable.kind === "owned" && health.owner === this.stable.owner) {
        this.stable.lastHealthyAt = Date.now();
        return;
      }
      if (this.stable.kind === "owned") await this.terminateOwned(this.stable);
      this.stable = { kind: "adopted", model, lastHealthyAt: Date.now() };
      this.lastError = undefined;
      console.log("[daemon] Adopted matching MLX embed server");
      return;
    }

    if (this.stable.kind === "owned") {
      await this.terminateOwned(this.stable);
    } else {
      this.stable = { kind: "stopped" };
    }
    if (this.shouldStop()) return;

    const portOwner = this.getPortPid(this.port);
    if (portOwner) {
      this.lastError = `port ${this.port} is occupied by unrecognized PID ${portOwner}`;
      this.phase = "failed";
      console.error(`[daemon] MLX ${this.lastError}; leaving it untouched`);
      return;
    }

    const candidates = [
      path.resolve(__dirname, "../../../mlx-embed-server"),
      path.resolve(__dirname, "../../mlx-embed-server"),
    ];
    const serverDir = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "server.py")),
    );
    if (!serverDir) {
      this.lastError = "MLX embed server not found";
      this.phase = "failed";
      console.warn(
        "[daemon] MLX embed server not found — falling back to CPU embeddings",
      );
      return;
    }

    const owner = this.deps.createOwnerToken?.() ?? randomUUID();
    const openLog = this.deps.openLog ?? openRotatedLog;
    const closeFd = this.deps.closeFd ?? fs.closeSync;
    const logFd = openLog(path.join(PATHS.logsDir, "mlx-embed-server.log"));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MLX_EMBED_MODEL: model,
      GMAX_EMBED_OWNER_TOKEN: owner,
      HF_HOME: resolveMlxHfHome(model),
    };

    this.phase = "starting";
    let child: ChildProcess;
    try {
      child = (this.deps.spawn ?? spawn)("uv", ["run", "python", "server.py"], {
        cwd: serverDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = "failed";
      console.error(
        `[daemon] MLX embed server failed to spawn: ${this.lastError} — falling back to CPU embeddings`,
      );
      return;
    } finally {
      try {
        closeFd(logFd);
      } catch {}
    }

    if (!child.pid) {
      this.lastError = "spawned MLX process has no PID";
      this.phase = "failed";
      return;
    }
    child.unref();
    const candidate: OwnedServer = {
      kind: "owned",
      child,
      pid: child.pid,
      model,
      owner,
      lastHealthyAt: 0,
    };
    const startup = { error: null as Error | null, exited: false };
    const onError = (error: Error) => {
      startup.error = error;
    };
    const onExit = () => {
      startup.exited = true;
    };
    child.on("error", onError);
    child.on("exit", onExit);
    console.log(`[daemon] Starting MLX embed server (PID: ${child.pid})`);

    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
      await this.sleep(STARTUP_POLL_MS);
      if (this.shouldStop() || startup.error || startup.exited) break;
      const readiness = await this.probeHealth(this.port);
      if (readiness.kind !== "healthy") continue;
      if (readiness.model !== model) {
        this.lastError = `port ${this.port} serves model ${readiness.model}, expected ${model}`;
        break;
      }
      child.off("error", onError);
      child.off("exit", onExit);
      if (readiness.owner !== owner) {
        await this.terminateOwned(candidate);
        this.stable = {
          kind: "adopted",
          model,
          lastHealthyAt: Date.now(),
        };
        console.log(
          "[daemon] Adopted matching MLX server that won startup race",
        );
        return;
      }
      candidate.lastHealthyAt = Date.now();
      this.stable = candidate;
      this.lastError = undefined;
      this.trackOwnedExit(candidate);
      console.log("[daemon] MLX embed server ready");
      return;
    }

    child.off("error", onError);
    child.off("exit", onExit);
    await this.terminateOwned(candidate);
    this.lastError =
      startup.error?.message ??
      (this.shouldStop() ? "MLX startup cancelled" : "MLX startup timed out");
    if (!this.shouldStop()) {
      this.phase = "failed";
      console.error(
        `[daemon] ${this.lastError} — falling back to CPU embeddings`,
      );
    }
  }

  stopMlxServer(): Promise<void> {
    this.enabled = false;
    this.phase = "stopping";
    if (this.stopFlight) return this.stopFlight;
    const flight = (async () => {
      await this.ensureFlight?.catch(() => {});
      if (this.stable.kind === "owned") {
        const owned = this.stable;
        await this.terminateOwned(owned);
        console.log(
          `[daemon] Stopped owned MLX embed server (PID: ${owned.pid})`,
        );
      } else {
        this.stable = { kind: "stopped" };
      }
      this.lastError = undefined;
    })().finally(() => {
      if (this.stopFlight === flight) this.stopFlight = null;
      this.phase = null;
    });
    this.stopFlight = flight;
    return flight;
  }

  getStatus(): MlxManagerStatus {
    const state =
      this.phase ??
      (this.stable.kind === "owned"
        ? "owned-ready"
        : this.stable.kind === "adopted"
          ? "adopted-ready"
          : "stopped");
    return {
      enabled: this.enabled,
      state,
      port: this.port,
      model: this.desiredModel,
      pid: this.stable.kind === "owned" ? this.stable.pid : null,
      ...(this.stable.kind === "stopped"
        ? {}
        : { lastHealthyAt: this.stable.lastHealthyAt }),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

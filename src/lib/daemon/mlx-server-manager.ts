import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { PATHS } from "../../config";
import { openRotatedLog } from "../utils/log-rotate";
import { killProcess } from "../utils/process";

/**
 * Owns the MLX embed server (port 8100) process lifecycle: spawn, health probe,
 * zombie recovery, and teardown. Fully isolated — touches only the port and the
 * child process, no shared daemon state beyond a shutting-down getter.
 *
 * Extracted from daemon.ts (Phase 2). `__dirname` resolves the bundled
 * mlx-embed-server/server.py relative to this file; it sits in the same
 * dist/lib/daemon directory as daemon.ts did, so resolution is unchanged.
 */
export class MlxServerManager {
  private mlxChild: ChildProcess | null = null;
  private mlxRecoveryInFlight = false;

  constructor(private readonly deps: { getShuttingDown: () => boolean }) {}

  private async isMlxServerUp(): Promise<boolean> {
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    return new Promise<boolean>((resolve) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: "/health", timeout: 2000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  private getPortPid(port: number): number | null {
    try {
      const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
      const pid = parseInt(out.split("\n")[0], 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  async checkMlxHealth(): Promise<void> {
    if (this.deps.getShuttingDown() || this.mlxRecoveryInFlight) return;
    if (await this.isMlxServerUp()) return;
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const stalePid = this.getPortPid(port);
    if (!stalePid) return; // No process — let the next user-facing path spawn it.
    this.mlxRecoveryInFlight = true;
    try {
      console.log(
        `[daemon] MLX zombie detected on port ${port} (PID ${stalePid}) — killing and respawning`,
      );
      await killProcess(stalePid);
      await new Promise((r) => setTimeout(r, 500));
      await this.ensureMlxServer();
    } catch (err) {
      console.error(
        `[daemon] MLX recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.mlxRecoveryInFlight = false;
    }
  }

  async ensureMlxServer(mlxModel?: string): Promise<void> {
    if (await this.isMlxServerUp()) {
      console.log("[daemon] MLX embed server already running");
      return;
    }

    // Kill stale process holding the port (orphaned from a previous daemon)
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const stalePid = this.getPortPid(port);
    if (stalePid) {
      console.log(`[daemon] Killing stale MLX process on port ${port} (PID: ${stalePid})`);
      await killProcess(stalePid);
      // Brief pause for OS to release the port
      await new Promise((r) => setTimeout(r, 500));
    }

    // Find mlx-embed-server/server.py relative to the grepmax package
    const candidates = [
      path.resolve(__dirname, "../../../mlx-embed-server"),
      path.resolve(__dirname, "../../mlx-embed-server"),
    ];
    const serverDir = candidates.find((d) =>
      fs.existsSync(path.join(d, "server.py")),
    );
    if (!serverDir) {
      console.warn("[daemon] MLX embed server not found — falling back to CPU embeddings");
      return;
    }

    const logFd = openRotatedLog(path.join(PATHS.logsDir, "mlx-embed-server.log"));
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (mlxModel) env.MLX_EMBED_MODEL = mlxModel;

    this.mlxChild = spawn("uv", ["run", "python", "server.py"], {
      cwd: serverDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    this.mlxChild.unref();
    console.log(`[daemon] Starting MLX embed server (PID: ${this.mlxChild.pid})`);

    // Poll for readiness (up to 30s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.isMlxServerUp()) {
        console.log("[daemon] MLX embed server ready");
        return;
      }
    }
    console.error("[daemon] MLX embed server failed to start within 30s — falling back to CPU embeddings");
    this.mlxChild = null;
  }

  stopMlxServer(): void {
    // The spawned process is `uv`, which forks `python` then exits. Killing the
    // recorded PID alone leaves python orphaned (the orphan source for port 8100
    // collisions across daemon restarts). Always also kill whoever owns the port.
    if (this.mlxChild?.pid) {
      try {
        process.kill(-this.mlxChild.pid, "SIGTERM");
      } catch {
        try { process.kill(this.mlxChild.pid, "SIGTERM"); } catch {}
      }
      console.log(`[daemon] Stopped MLX embed server (PID: ${this.mlxChild.pid})`);
      this.mlxChild = null;
    }
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const portOwner = this.getPortPid(port);
    if (portOwner) {
      try {
        process.kill(portOwner, "SIGTERM");
        console.log(`[daemon] Killed orphan MLX on port ${port} (PID: ${portOwner})`);
      } catch {}
    }
  }
}

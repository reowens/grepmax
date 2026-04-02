import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { PATHS } from "../../config";
import { openRotatedLog } from "../utils/log-rotate";
import { type LlmConfig, getLlmConfig } from "./config";

const HEALTH_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 500;
const STOP_GRACE_MS = 5000;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export class LlmServer {
  private config: LlmConfig;
  private lastRequestTime = 0;
  private startTime = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.config = getLlmConfig();
  }

  /** HTTP GET /v1/models — returns true if llama-server is responding. */
  healthy(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: this.config.host,
          port: this.config.port,
          path: "/v1/models",
          timeout: HEALTH_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** Start llama-server, poll until ready, start idle watchdog. */
  async start(): Promise<void> {
    if (await this.healthy()) return;

    // Validate binary
    const binary = this.config.binary;
    try {
      execSync(`which ${binary}`, { stdio: "ignore" });
    } catch {
      throw new Error(
        `llama-server binary not found: "${binary}". Install llama.cpp or set GMAX_LLM_BINARY`,
      );
    }

    // Validate model file
    if (!fs.existsSync(this.config.model)) {
      throw new Error(
        `Model file not found: "${this.config.model}". Set GMAX_LLM_MODEL to a valid .gguf path`,
      );
    }

    const logFd = openRotatedLog(PATHS.llmLogFile);

    const child = spawn(
      binary,
      [
        "-m", this.config.model,
        "--host", this.config.host,
        "--port", String(this.config.port),
        "-ngl", String(this.config.ngl),
        "--ctx-size", String(this.config.ctxSize),
      ],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    child.unref();
    fs.closeSync(logFd);

    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn llama-server — no PID returned");
    }

    fs.writeFileSync(PATHS.llmPidFile, String(pid));
    console.log(`[llm] Starting llama-server (PID: ${pid}, port: ${this.config.port})`);

    // Poll until ready
    const deadline = Date.now() + this.config.startupWaitSec * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      // Check if process died
      try {
        process.kill(pid, 0);
      } catch {
        throw new Error(
          `llama-server process died during startup — check ${PATHS.llmLogFile}`,
        );
      }

      if (await this.healthy()) {
        this.startTime = Date.now();
        this.lastRequestTime = Date.now();
        this.startIdleWatchdog();
        console.log("[llm] Server ready");
        return;
      }
    }

    // Timeout — kill the process
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { fs.unlinkSync(PATHS.llmPidFile); } catch {}
    throw new Error(
      `llama-server startup timed out after ${this.config.startupWaitSec}s — check ${PATHS.llmLogFile}`,
    );
  }

  /** Stop llama-server gracefully (SIGTERM → wait → SIGKILL). */
  async stop(): Promise<void> {
    this.stopIdleWatchdog();

    const pid = this.readPid();
    if (!pid) return;

    // Check if alive
    try {
      process.kill(pid, 0);
    } catch {
      this.cleanupPidFile();
      return;
    }

    // SIGTERM
    try { process.kill(pid, "SIGTERM"); } catch {}

    // Wait up to 5s
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        process.kill(pid, 0);
      } catch {
        // Process exited
        this.cleanupPidFile();
        console.log(`[llm] Server stopped (PID: ${pid})`);
        return;
      }
    }

    // Force kill
    try { process.kill(pid, "SIGKILL"); } catch {}
    this.cleanupPidFile();
    console.log(`[llm] Server force-killed (PID: ${pid})`);
  }

  /** Start if not running. */
  async ensure(): Promise<void> {
    if (await this.healthy()) {
      this.touchIdle();
      return;
    }
    await this.start();
  }

  /** Mark activity — resets idle timer. Called by inference endpoints. */
  touchIdle(): void {
    this.lastRequestTime = Date.now();
  }

  /** Get current status for IPC/CLI display. */
  getStatus(): {
    running: boolean;
    pid: number | null;
    port: number;
    model: string;
    uptime: number;
  } {
    const pid = this.readPid();
    const alive = pid ? this.isAlive(pid) : false;
    return {
      running: alive,
      pid: alive ? pid : null,
      port: this.config.port,
      model: this.config.model,
      uptime: alive && this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  private startIdleWatchdog(): void {
    this.stopIdleWatchdog();
    const timeoutMs = this.config.idleTimeoutMin * 60 * 1000;

    this.idleTimer = setInterval(async () => {
      if (this.lastRequestTime === 0) return;
      if (Date.now() - this.lastRequestTime > timeoutMs) {
        console.log(`[llm] Server idle for ${this.config.idleTimeoutMin}min, shutting down`);
        await this.stop();
      }
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref();
  }

  private stopIdleWatchdog(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private readPid(): number | null {
    try {
      const raw = fs.readFileSync(PATHS.llmPidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private cleanupPidFile(): void {
    try { fs.unlinkSync(PATHS.llmPidFile); } catch {}
    this.startTime = 0;
  }
}

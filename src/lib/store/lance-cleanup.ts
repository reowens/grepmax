import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import {
  type PruneState,
  readPruneState,
  writePruneState,
} from "./prune-state";
import { admitPrune, type PruneAdmission } from "./recovery-admission";
import { StoreLease, storeLeasePaths } from "./store-lease";

const project = path.resolve(__dirname, "../../../lance-maintenance");
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_HELPER_MS = 120_000;
// Pruning deletes at 32 files/second. Thousands of retained manifests and
// transactions cannot fit a two-minute window even with an idle host.
const MAX_PRUNE_MS = 600_000;
export interface CleanupRuntime {
  python: string;
  script: string;
}
export interface PruneResult {
  engine: "12.0.0";
  version: number;
  fragments: number;
  bytesRemoved: number;
  versionsRemoved: number;
  rewritten: false;
  fileBytesBefore: number;
  fileBytesAfter: number;
  allocatedBytesBefore: number;
  allocatedBytesAfter: number;
  freeBytesBefore: number;
  freeBytesAfter: number;
}
export interface PruneOptions {
  lease: StoreLease;
  signal?: AbortSignal;
  admission?: PruneAdmission;
  acknowledgeUncertain?: string;
}

/** No shell, inherited service credentials, Python path hooks or source builds.
 * Thread settings apply before Arrow/Lance imports in the child. */
function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "SystemRoot",
    "LOCALAPPDATA",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    RAYON_NUM_THREADS: "1",
    TOKIO_WORKER_THREADS: "1",
    OMP_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
    UV_CONCURRENT_DOWNLOADS: "1",
    UV_CONCURRENT_INSTALLS: "1",
    UV_CONCURRENT_BUILDS: "1",
    UV_PYTHON_DOWNLOADS: "never",
  };
}

/** Settle only after close, including abort/timeout. Releasing an exclusive lease
 * on AbortError before the child exits would let writers race native deletion. */
export function runCleanupProcess(
  executable: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    admission?: PruneAdmission & { nonce: string };
  } = {},
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Cleanup cancelled before launch"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...helperEnvironment(), ...options.env },
      stdio: [options.admission ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostics = "";
    let bytes = 0;
    let failure: Error | undefined;
    let approved = false;
    let launched = false;
    let readyBuffer = "";
    let monitor: ReturnType<typeof setInterval> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string): void => {
      failure ??= new Error(`${reason}; cleanup completion is uncertain`);
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = (): void => stop("Cleanup cancelled");
    const timeout = setTimeout(
      () => stop("Cleanup timed out"),
      Math.min(options.timeoutMs ?? MAX_HELPER_MS, MAX_PRUNE_MS),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    // stderr is deliberately not returned: child diagnostics may contain paths,
    // tokens or registry URLs. Retain a concrete bounded exit/signal/error code.
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("Cleanup output exceeded limit");
        else if (stream === child.stdout) {
          if (options.admission && !approved) {
            readyBuffer += chunk.toString("utf8");
            let end = readyBuffer.indexOf("\n");
            while (end >= 0 && !approved && !failure) {
              try {
                const phase = JSON.parse(readyBuffer.slice(0, end)).admission;
                readyBuffer = readyBuffer.slice(end + 1);
                if (phase === "launch" && !launched) {
                  if (!child.stdin) throw Error();
                  child.stdin.write(`${options.admission.nonce}\n`);
                  launched = true;
                } else if (phase === "ready" && launched) {
                  options.admission.approve();
                  child.stdin!.end(`${options.admission.nonce}\n`);
                  approved = true;
                  output += readyBuffer;
                  readyBuffer = "";
                } else throw Error();
              } catch {
                stop("Prune deletion admission refused");
              }
              end = readyBuffer.indexOf("\n");
            }
          } else output += chunk.toString("utf8");
        } else diagnostics += chunk.toString("utf8");
      });
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= new Error(
        `Cleanup process could not start (${error.code ?? "unknown"})`,
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (monitor) clearInterval(monitor);
      try {
        options.admission?.close();
      } catch {
        failure ??= new Error(
          "Prune ownership/resource close failed; completion is uncertain",
        );
      }
      if (options.admission && !approved)
        failure ??= new Error(
          "Prune deletion was not admitted; completion is uncertain",
        );
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) {
        // Whitelist categories, never repeat registry credentials, file paths,
        // full traceback text or arbitrary diagnostics from a subprocess.
        const detail =
          /lockfile.*(?:needs|updated|out.of.date)|locked.*(?:changed|update)/i.test(
            diagnostics,
          )
            ? "locked project/runtime mismatch"
            : /no space left|ENOSPC/i.test(diagnostics)
              ? "disk full"
              : /no (?:python|interpreter)|python.*(?:not found|unavailable)/i.test(
                    diagnostics,
                  )
                ? "compatible Python unavailable"
                : /failed to (?:download|fetch)|connection refused|network|cache missing/i.test(
                      diagnostics,
                    )
                  ? "download, network or cache unavailable"
                  : /exclusive (?:lease|ownership)|shared store owners/i.test(
                        diagnostics,
                      )
                    ? "exclusive ownership verification failed"
                    : /protected state|table changed|state.*changed/i.test(
                          diagnostics,
                        )
                      ? "current/protected state verification failed"
                      : "unclassified child failure";
        reject(
          new Error(
            `Cleanup process exited (${signal ?? code ?? "unknown"}): ${detail}; cleanup completion is uncertain`,
          ),
        );
      } else resolve(output);
    });
    child.stdin?.on("error", () => stop("Prune admission pipe failed"));
    if (options.admission) {
      try {
        if (!child.pid) throw Error();
        options.admission.start(child.pid);
        monitor = setInterval(() => {
          try {
            options.admission!.check();
          } catch {
            stop("Prune host/resource admission changed");
          }
        }, 5000);
      } catch {
        stop("Prune helper launch admission refused");
      }
    }
    if (options.signal?.aborted) abort();
  });
}

let preparation: Promise<CleanupRuntime> | undefined;
/** Explicit recovery only. Containment has no automatic caller of this setup. */
export async function prepareCleanupRuntime(
  signal?: AbortSignal,
): Promise<CleanupRuntime> {
  if (signal?.aborted) throw new Error("Cleanup setup cancelled");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Prune-only runtime currently supports macOS and Linux");
  if (!preparation) {
    preparation = (async () => {
      const stdout = await runCleanupProcess("uv", ["--version"], {
        signal,
        timeoutMs: 10_000,
      });
      const match = /^uv (\d+)\.(\d+)\.(\d+)/.exec(stdout);
      if (
        !match ||
        (Number(match[1]) === 0 &&
          (Number(match[2]) < 12 ||
            (Number(match[2]) === 12 && Number(match[3]) < 18)))
      ) {
        throw new Error("Prune-only runtime requires uv >=0.12.18");
      }
      const hash = createHash("sha256")
        .update(fs.readFileSync(path.join(project, "pyproject.toml")))
        .update(fs.readFileSync(path.join(project, "uv.lock")))
        .digest("hex")
        .slice(0, 16);
      const root = path.join(PATHS.sharedRoot, "runtimes");
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(root).isSymbolicLink())
        throw new Error("Unverified cleanup runtime directory");
      fs.chmodSync(root, 0o700);
      const environment = path.join(root, `lance-cleanup-${hash}`);
      const python = path.join(
        environment,
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      if (fs.existsSync(environment)) {
        if (
          !fs.lstatSync(environment).isDirectory() ||
          fs.lstatSync(environment).isSymbolicLink()
        )
          throw new Error("Unverified cleanup environment");
        await runCleanupProcess(
          "uv",
          [
            "sync",
            "--check",
            "--locked",
            "--offline",
            "--project",
            project,
            "--no-dev",
            "--no-python-downloads",
            "--no-build",
          ],
          {
            signal,
            timeoutMs: 10_000,
            env: { UV_PROJECT_ENVIRONMENT: environment },
          },
        );
        return { python, script: path.join(project, "prune.py") };
      }
      const available = fs.statfsSync(root);
      const freeBytes = available.bavail * available.bsize;
      if (!Number.isFinite(freeBytes) || freeBytes < 512 * 1024 ** 2) {
        throw new Error("Cleanup runtime setup refused: less than 512MiB free");
      }
      await runCleanupProcess(
        "uv",
        [
          "sync",
          "--locked",
          "--project",
          project,
          "--no-dev",
          "--no-python-downloads",
          "--no-build",
        ],
        {
          signal,
          env: { UV_PROJECT_ENVIRONMENT: environment },
        },
      );
      fs.chmodSync(environment, 0o700);
      return {
        python,
        script: path.join(project, "prune.py"),
      };
    })().catch((error) => {
      preparation = undefined;
      throw error;
    });
  }
  return preparation;
}

/** Explicit recovery only. Caller must have drained local work/readers before
 * acquiring the exclusive lease. The lease cannot be released during this call. */
export async function pruneVersions(
  runtime: CleanupRuntime,
  store: string,
  version: number,
  cutoff: Date,
  options: PruneOptions,
): Promise<PruneResult> {
  if (!(options?.lease instanceof StoreLease))
    throw new Error("Pruning requires a verified StoreLease token");
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(cutoff.getTime()) ||
    cutoff.getTime() > Date.now()
  ) {
    throw new Error("Invalid prune version or future cutoff");
  }
  const table = fs.realpathSync(store);
  if (!table.endsWith(".lance") || !fs.statSync(table).isDirectory())
    throw new Error("Pruning requires a local Lance table");
  const storeDir = path.dirname(table);
  if (options.signal?.aborted)
    throw new Error("Cleanup cancelled before launch");
  let attempt: PruneState | undefined;
  let admission: PruneAdmission | undefined;
  try {
    const result = await options.lease.withExclusiveUse(storeDir, async () => {
      const previous = readPruneState(storeDir);
      if (
        previous?.outcome === "uncertain" &&
        options.acknowledgeUncertain !== previous.attemptId
      )
        throw new Error(
          `Previous prune completion is uncertain; explicit acknowledgement required for attempt ${previous.attemptId}`,
        );
      admission = options.admission ?? admitPrune(storeDir);
      attempt = {
        schemaVersion: 1,
        storeIdentity: fs.realpathSync(storeDir),
        attemptId: randomUUID(),
        version,
        cutoffMs: cutoff.getTime(),
        startedAt: Date.now(),
        outcome: "running",
        previousUncertainAttemptId:
          previous?.outcome === "uncertain"
            ? previous.attemptId
            : previous?.previousUncertainAttemptId,
      };
      writePruneState(attempt);
      let unpin: (() => void) | undefined;
      const stdout = await runCleanupProcess(
        runtime.python,
        [
          "-I",
          runtime.script,
          "--store",
          table,
          "--version",
          String(version),
          "--cutoff-ms",
          String(cutoff.getTime()),
          "--lease-owner",
          storeLeasePaths(storeDir).intentOwnerFile,
          "--lease-nonce",
          options.lease.owner.nonce,
          "--require-admission",
        ],
        {
          signal: options.signal,
          timeoutMs: MAX_PRUNE_MS,
          admission: {
            nonce: options.lease.owner.nonce,
            start: (pid) => {
              unpin = options.lease.pinExclusiveHelper(pid);
              admission!.start(pid);
            },
            approve: () => admission!.approve(),
            check: () => admission!.check(),
            close: () => {
              try {
                unpin?.();
              } finally {
                admission!.close();
                admission = undefined;
              }
            },
          },
        },
      );
      const result: PruneResult = JSON.parse(stdout);
      if (
        result.engine !== "12.0.0" ||
        result.version !== version ||
        result.rewritten !== false ||
        ![
          "fragments",
          "bytesRemoved",
          "versionsRemoved",
          "fileBytesBefore",
          "fileBytesAfter",
          "allocatedBytesBefore",
          "allocatedBytesAfter",
          "freeBytesBefore",
          "freeBytesAfter",
        ].every((key) => {
          const value = result[key as keyof PruneResult];
          return (
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0
          );
        })
      )
        throw new Error(
          "Invalid prune-only cleanup result; cleanup completion is uncertain",
        );
      return result;
    });
    // withExclusiveUse verifies ownership again before this synchronous write.
    // The caller still holds the lease; it cannot release it during the helper.
    writePruneState({
      ...attempt!,
      outcome: "completed",
      finishedAt: Date.now(),
      result,
    });
    return result;
  } catch (error) {
    if (attempt) {
      try {
        writePruneState({
          ...attempt,
          outcome: "uncertain",
          finishedAt: Date.now(),
        });
      } catch {
        throw new Error(
          "Prune completion is uncertain; durable outcome could not be recorded",
        );
      }
    }
    throw error;
  } finally {
    admission?.close();
  }
}

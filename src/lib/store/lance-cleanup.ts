import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { StoreLease, storeLeasePaths } from "./store-lease";

const project = path.resolve(__dirname, "../../../lance-maintenance");
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_HELPER_MS = 120_000;
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
  } = {},
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Cleanup cancelled before launch"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...helperEnvironment(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostics = "";
    let bytes = 0;
    let failure: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string): void => {
      failure ??= new Error(`${reason}; cleanup completion is uncertain`);
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = (): void => stop("Cleanup cancelled");
    const timeout = setTimeout(
      () => stop("Cleanup timed out"),
      Math.min(options.timeoutMs ?? MAX_HELPER_MS, MAX_HELPER_MS),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    // stderr is deliberately not returned: child diagnostics may contain paths,
    // tokens or registry URLs. Retain a concrete bounded exit/signal/error code.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("Cleanup output exceeded limit");
        else if (stream === child.stdout) output += chunk.toString("utf8");
        else diagnostics += chunk.toString("utf8");
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
    if (options.signal?.aborted) abort();
  });
}

let preparation: Promise<CleanupRuntime> | undefined;
/** Explicit recovery only. Containment has no automatic caller of this setup. */
export async function prepareCleanupRuntime(
  signal?: AbortSignal,
): Promise<CleanupRuntime> {
  if (signal?.aborted) throw new Error("Cleanup setup cancelled");
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
      fs.chmodSync(root, 0o700);
      const available = fs.statfsSync(root);
      const freeBytes = available.bavail * available.bsize;
      if (!Number.isFinite(freeBytes) || freeBytes < 512 * 1024 ** 2) {
        throw new Error("Cleanup runtime setup refused: less than 512MiB free");
      }
      const environment = path.join(root, `lance-cleanup-${hash}`);
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
        python: path.join(
          environment,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        ),
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
  return options.lease.withExclusiveUse(storeDir, async () => {
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
      ],
      { signal: options.signal },
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
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        );
      })
    )
      throw new Error(
        "Invalid prune-only cleanup result; cleanup completion is uncertain",
      );
    return result;
  });
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface BoundedMaintenanceRuntime {
  executable: string;
  incrementalRepairProtocol?: 1;
}

interface NativeManifest {
  schemaVersion: 1;
  engine: "12.0.0";
  sourceSha256: string;
  qualified: boolean;
  binaries: Record<string, { file: string; sha256: string }>;
}

const digestPattern = /^[a-f0-9]{64}$/;
const platforms = new Set(["darwin-arm64", "linux-x64"]);

/** No runtime compiler, download or environment override. Missing/unqualified
 * artifacts leave independent version cleanup available. Corruption refuses. */
export async function verifyBoundedRuntimeAt(
  root: string,
  platform: string,
  signal?: AbortSignal,
): Promise<BoundedMaintenanceRuntime | null> {
  signal?.throwIfAborted();
  if (!platforms.has(platform)) return null;
  const file = path.join(root, "manifest.json");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.size > 64 * 1024)
    throw new Error("Unverified bounded maintenance manifest");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as NativeManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.engine !== "12.0.0" ||
    !digestPattern.test(manifest.sourceSha256) ||
    typeof manifest.qualified !== "boolean" ||
    !manifest.binaries ||
    typeof manifest.binaries !== "object"
  )
    throw new Error("Invalid bounded maintenance provenance");
  if (!manifest.qualified) return null;
  const entry = manifest.binaries[platform];
  if (!entry) return null;
  const name = `gmax-bounded-maintenance-${platform}`;
  if (entry.file !== name || !digestPattern.test(entry.sha256))
    throw new Error("Invalid bounded maintenance binary entry");
  const executable = path.join(root, name);
  const binary = fs.lstatSync(executable);
  if (
    !binary.isFile() ||
    binary.size < 1 ||
    binary.size > 256 * 1024 ** 2 ||
    fs.realpathSync(executable) !== path.join(fs.realpathSync(root), name)
  )
    throw new Error("Unverified bounded maintenance binary");
  const hash = createHash("sha256");
  const input = fs.createReadStream(executable, { highWaterMark: 64 * 1024 });
  const abort = () =>
    input.destroy(new Error("Runtime verification cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    input.destroy();
  }
  if (hash.digest("hex") !== entry.sha256)
    throw new Error("Bounded maintenance binary checksum mismatch");
  signal?.throwIfAborted();
  const incrementalRepairProtocol = await verifyCapabilities(
    executable,
    signal,
  );
  return Object.freeze({
    executable,
    ...(incrementalRepairProtocol ? { incrementalRepairProtocol } : {}),
  });
}

function verifyCapabilities(
  executable: string,
  signal?: AbortSignal,
): Promise<1 | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--capabilities"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, RAYON_NUM_THREADS: "1" },
    });
    let output = "";
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = () => stop("Native capability verification cancelled");
    const timeout = setTimeout(
      () => stop("Native capability verification timed out"),
      5000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 4096)
        stop("Native capability output exceeded limit");
      else output += chunk.toString("utf8");
    });
    child.on("error", () => {
      failure ??= new Error("Native capability process could not start");
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try {
        const report = JSON.parse(output);
        if (
          code !== 0 ||
          report.protocolVersion !== 1 ||
          report.engine !== "12.0.0" ||
          report.nativeTotalWriteBudgetEnforced !== true ||
          report.budgetKind !== "cumulative-writes" ||
          report.protectedReaderProtocol !== 1
        )
          throw new Error();
        if (
          report.incrementalRepairProtocol !== undefined &&
          report.incrementalRepairProtocol !== 1
        )
          throw new Error();
        resolve(report.incrementalRepairProtocol);
      } catch {
        reject(new Error("Native bounded maintenance capabilities unverified"));
      }
    });
  });
}

export async function prepareBoundedMaintenanceRuntime(
  signal?: AbortSignal,
): Promise<BoundedMaintenanceRuntime | null> {
  return verifyBoundedRuntimeAt(
    path.resolve(__dirname, "../../vendor/maintenance"),
    `${process.platform}-${process.arch}`,
    signal,
  );
}

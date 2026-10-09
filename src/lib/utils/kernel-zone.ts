import { execFileSync } from "node:child_process";

/**
 * macOS kernel-zone pressure guard.
 *
 * On macOS 26.5.2 (build 25F84) the `data.kalloc.1024` kernel zone leaks under
 * sustained filesystem write pressure and is never reclaimed. Exhausting it panics
 * the host outright — no jetsam, no swap warning, no chance to intervene, because
 * the failing resource is wired kernel memory rather than anything the VM system
 * manages.
 *
 * This host panicked three times that way. The third time the zone sat near 1.4 GB
 * for twelve days, then climbed to 17.9 GB in eight hours while gmax's compactor
 * dirtied 549.76 GB of file-backed memory. See
 * docs/2026-08-04-macos-kernel-zone-panic-incident.md.
 *
 * gmax cannot fix the kernel defect, but it can decline to be the thing that
 * detonates it. Sampling the zone has taken 1.584 s on the incident host, so the
 * probe uses a bounded five-second budget. The daemon stands down while there
 * are still hours of headroom.
 */

/** The zone that leaks. Named explicitly so `zprint` returns a single line. */
const ZONE_NAME = "data.kalloc.1024";

// Two 500 ms probes timed out on the incident host; a subsequent probe completed
// in 1,584 ms. Keep the previous five-second ceiling to allow scheduling margin.
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Warn threshold.
 *
 * Twelve days of ordinary use held this zone between 0.67 and 1.37 GiB, so 4 GiB is
 * roughly 3x anything a healthy host has been observed to reach. During the
 * August 17 burst the zone crossed this about 90 minutes in — early enough that
 * stopping then would have avoided the panic with hours to spare.
 */
const WARN_BYTES = 4 * 1024 ** 3;

/**
 * Critical threshold — the daemon stands down here.
 *
 * The observed zone map cap on this hardware is ~17.6 GiB. Eight GiB is under half
 * of it, and at the burst rate actually measured (~2.0 GiB/hour) it still leaves
 * roughly five hours before exhaustion. The margin is deliberately generous: the
 * cost of standing down early is a stale index, and the cost of standing down late
 * is an unplanned reboot.
 */
const CRITICAL_BYTES = 8 * 1024 ** 3;

export type ZonePressure = "ok" | "warn" | "critical";

export interface KernelZoneUsage {
  /** Live elements in the zone. */
  elements: number;
  /** Element size in bytes, as reported by the kernel. */
  elementSize: number;
  /** elements * elementSize. */
  bytes: number;
  pressure: ZonePressure;
}

export type MemoryPressure = "normal" | "warn" | "critical";
export type ProbeFailureReason =
  | "timeout"
  | "output-limit"
  | "exit"
  | "execution"
  | "parse";

export interface ProbeObservation {
  /** Wall-clock observation start; duration uses a monotonic clock. */
  sampledAtMs: number;
  durationMs: number;
  /** Captured stdout size only. Raw stdout/stderr/error messages are not exposed. */
  outputBytes: number;
}
type ProbeUnavailable =
  | { status: "unsupported"; reason: "unsupported-platform" }
  | {
      status: "unknown";
      reason: ProbeFailureReason;
      errorCode: string | null;
      exitCode: number | null;
      signal: string | null;
    };
export type KernelZoneProbeResult = ProbeObservation &
  ({ status: "known"; usage: KernelZoneUsage } | ProbeUnavailable);
export type MemoryPressureProbeResult = ProbeObservation &
  (
    | { status: "known"; pressure: MemoryPressure; level?: 1 | 2 | 4 }
    | ProbeUnavailable
  );

/** Compact diagnostic metadata; never serializes raw probe output or errors. */
export function formatPressureProbe(
  result: KernelZoneProbeResult | MemoryPressureProbeResult,
): string {
  return JSON.stringify({
    status: result.status,
    sampledAtMs: result.sampledAtMs,
    durationMs: result.durationMs,
    outputBytes: result.outputBytes,
    ...(result.status !== "known" ? { reason: result.reason } : {}),
    ...(result.status === "unknown"
      ? {
          errorCode: result.errorCode,
          exitCode: result.exitCode,
          signal: result.signal,
        }
      : {}),
  });
}

interface ProbeOptions {
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  stdio: ["ignore", "pipe", "ignore"];
}
/** Injection seam for bounded tests; production budgets cannot be overridden. */
export interface PressureProbeDeps {
  platform: string;
  wallNow: () => number;
  monotonicNow: () => number;
  run: (command: string, args: string[], options: ProbeOptions) => string;
}

const PROBE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ENOBUFS",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ENOENT",
  "EACCES",
  "EPERM",
]);
const PROBE_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"]);

function stdoutBytes(output: unknown): number {
  return typeof output === "string"
    ? Buffer.byteLength(output)
    : Buffer.isBuffer(output)
      ? output.length
      : 0;
}

function boundedPressureProbe<T>(
  command: string,
  args: string[],
  timeout: number,
  parse: (output: string) => T | null,
  overrides: Partial<PressureProbeDeps>,
): ProbeObservation & ({ status: "known"; value: T } | ProbeUnavailable) {
  const deps: PressureProbeDeps = {
    platform: process.platform,
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
    run: (cmd, argv, options) => execFileSync(cmd, argv, options),
    ...overrides,
  };
  const sampledAtMs = deps.wallNow();
  const started = deps.monotonicNow();
  let outputBytes = 0;
  const observation = (): ProbeObservation => ({
    sampledAtMs,
    durationMs: Math.max(0, deps.monotonicNow() - started),
    outputBytes,
  });
  if (deps.platform !== "darwin")
    return {
      ...observation(),
      status: "unsupported",
      reason: "unsupported-platform",
    };
  try {
    const output = deps.run(command, args, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    outputBytes = stdoutBytes(output);
    const value = parse(output);
    return value === null
      ? {
          ...observation(),
          status: "unknown",
          reason: "parse",
          errorCode: null,
          exitCode: null,
          signal: null,
        }
      : { ...observation(), status: "known", value };
  } catch (error) {
    const details =
      error && typeof error === "object"
        ? (error as {
            code?: unknown;
            status?: unknown;
            signal?: unknown;
            stdout?: unknown;
          })
        : {};
    outputBytes = stdoutBytes(details.stdout);
    const errorCode =
      typeof details.code === "string" && PROBE_ERROR_CODES.has(details.code)
        ? details.code
        : details.code == null
          ? null
          : "UNKNOWN";
    const exitCode =
      typeof details.status === "number" && Number.isInteger(details.status)
        ? details.status
        : null;
    const signal =
      typeof details.signal === "string" && PROBE_SIGNALS.has(details.signal)
        ? details.signal
        : null;
    const reason: ProbeFailureReason =
      errorCode === "ETIMEDOUT"
        ? "timeout"
        : errorCode === "ENOBUFS" ||
            errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "output-limit"
          : exitCode !== null || signal !== null
            ? "exit"
            : "execution";
    return {
      ...observation(),
      status: "unknown",
      reason,
      errorCode,
      exitCode,
      signal,
    };
  }
}

export function probeKernelZoneUsage(
  zoneName = ZONE_NAME,
  overrides: Partial<PressureProbeDeps> = {},
): KernelZoneProbeResult {
  const result = boundedPressureProbe(
    "zprint",
    // A name only filters printed rows; zprint still prepares the wired-memory
    // report (including kernel symbolication) by default. -L skips that work.
    // On the incident host this reduced 6–10 second probes to 23–85 ms without
    // changing the zone counters, timeout, or fail-closed admission policy.
    ["-L", zoneName],
    PROBE_TIMEOUT_MS,
    (output) => {
      const parsed = parseZprintOutput(output, zoneName);
      if (!parsed) return null;
      const bytes = parsed.elements * parsed.elementSize;
      if (!Number.isSafeInteger(bytes)) return null;
      return { ...parsed, bytes, pressure: classifyZonePressure(bytes) };
    },
    overrides,
  );
  if (result.status !== "known") return result;
  const { value, ...observation } = result;
  return { ...observation, usage: value };
}

/** XNU publishes dispatch flags NORMAL=1, WARN=2, CRITICAL=4 through this sysctl.
 * https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
 * Other values are unknown, including the unrelated internal kernel enum. */
export function probeMemoryPressure(
  overrides: Partial<PressureProbeDeps> = {},
): MemoryPressureProbeResult {
  const result = boundedPressureProbe(
    "sysctl",
    ["-n", "kern.memorystatus_vm_pressure_level"],
    1_000,
    (output): { pressure: MemoryPressure; level: 1 | 2 | 4 } | null => {
      switch (output.trim()) {
        case "1":
          return { pressure: "normal", level: 1 };
        case "2":
          return { pressure: "warn", level: 2 };
        case "4":
          return { pressure: "critical", level: 4 };
        default:
          return null;
      }
    },
    overrides,
  );
  if (result.status !== "known") return result;
  const { value, ...observation } = result;
  return { ...observation, ...value };
}

export function classifyZonePressure(bytes: number): ZonePressure {
  if (bytes >= CRITICAL_BYTES) return "critical";
  if (bytes >= WARN_BYTES) return "warn";
  return "ok";
}

/**
 * Parse one `zprint <zone>` report.
 *
 * Exported for tests; the column layout is a stable but undocumented text format,
 * so this validates rather than trusting it:
 *
 * ```
 *                             elem         cur         max        cur         max         cur  alloc  alloc
 * zone name                   size        size        size      #elts       #elts       inuse   size  count
 * data.kalloc.1024            1024          0K          0K          0           0        3416     0K      0
 * ```
 *
 * The `cur size` column reads `0K` on this build, which is why the byte figure is
 * derived from `cur inuse` x `elem size` rather than read directly.
 */
export function parseZprintOutput(
  output: string,
  zoneName = ZONE_NAME,
): { elements: number; elementSize: number } | null {
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== zoneName) continue;
    const elementSize = Number(fields[1]);
    const elements = Number(fields[6]);
    if (!Number.isInteger(elementSize) || elementSize <= 0) return null;
    if (!Number.isInteger(elements) || elements < 0) return null;
    return { elements, elementSize };
  }
  return null;
}

/**
 * Sample the zone. Returns null off macOS, or whenever the sample cannot be
 * trusted. An unparseable or timed-out report reads as "unknown", never as
 * "healthy". macOS startup and heavy-operation admission refuse unknown samples.
 */
export function readKernelZoneUsage(
  zoneName = ZONE_NAME,
): KernelZoneUsage | null {
  const result = probeKernelZoneUsage(zoneName);
  return result.status === "known" ? result.usage : null;
}

export function formatZoneUsage(usage: KernelZoneUsage): string {
  const gib = (usage.bytes / 1024 ** 3).toFixed(2);
  return `${ZONE_NAME} at ${gib}GiB (${usage.elements.toLocaleString()} elements)`;
}

export const ZONE_THRESHOLDS = {
  warnBytes: WARN_BYTES,
  criticalBytes: CRITICAL_BYTES,
  zoneName: ZONE_NAME,
} as const;

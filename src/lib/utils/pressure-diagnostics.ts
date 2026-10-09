import type { HostGuardPolicy } from "./host-guard-policy";
import type { HostResourceSnapshot } from "./host-resource";
import type {
  KernelZoneProbeResult,
  MemoryPressureProbeResult,
} from "./kernel-zone";

export interface PressureProbes {
  memoryInitial?: MemoryPressureProbeResult;
  kernel?: KernelZoneProbeResult;
  memoryFinal?: MemoryPressureProbeResult;
}
export type SafetyStopAction =
  | "check"
  | "reserve"
  | "startup"
  | "pressure-check"
  | "heartbeat"
  | "operation"
  | "worker-spawn";
type ReservationKind =
  | "worker"
  | "embedding"
  | "native-store"
  | "llm"
  | "prune-helper"
  | "prune-runtime-setup"
  | "other";
interface ProbeEvidence {
  status: "known" | "unknown" | "unsupported";
  sampledAtMs?: number;
  durationMs?: number;
  outputBytes?: number;
  reason?: string;
  memoryPressure?: HostResourceSnapshot["memoryPressure"];
  memoryLevel?: 1 | 2 | 4;
  kernelPressure?: HostResourceSnapshot["kernelPressure"];
  kernelBytes?: number;
  kernelElements?: number;
  kernelElementSize?: number;
}
/** Only bounded enums and measurements, never argv, paths, queries or raw output. */
export interface SafetyStopDiagnostics {
  source: "resource-admission" | "daemon-pressure" | "worker-spawn";
  action: SafetyStopAction;
  policy: HostGuardPolicy;
  pid: number;
  reservationKind?: ReservationKind;
  reservationMb?: number;
  snapshot?: Omit<
    Pick<
      HostResourceSnapshot,
      | "at"
      | "completedAt"
      | "memoryPressure"
      | "kernelPressure"
      | "kernelBytes"
      | "aggregateFootprintMb"
      | "physicalFreeMb"
      | "swapUsedMb"
    >,
    "at" | "completedAt"
  > & { at: number | null; completedAt: number | null };
  probes?: {
    memoryInitial?: ProbeEvidence;
    kernel?: ProbeEvidence;
    memoryFinal?: ProbeEvidence;
  };
}
const sources = new Set([
  "resource-admission",
  "daemon-pressure",
  "worker-spawn",
]);
const actions = new Set<SafetyStopAction>([
  "check",
  "reserve",
  "startup",
  "pressure-check",
  "heartbeat",
  "operation",
  "worker-spawn",
]);
const kinds = new Set<ReservationKind>([
  "worker",
  "embedding",
  "native-store",
  "llm",
  "prune-helper",
  "prune-runtime-setup",
  "other",
]);
const memoryStates = new Set([
  "normal",
  "warn",
  "critical",
  "unknown",
  "unsupported",
]);
const kernelStates = new Set([
  "ok",
  "warn",
  "critical",
  "unknown",
  "unsupported",
]);
const reasons = new Set([
  "timeout",
  "output-limit",
  "exit",
  "execution",
  "parse",
  "unsupported-platform",
]);
const number = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
const nullableNumber = (n: unknown): number | null => number(n) ?? null;
function cleanProbe(p: ProbeEvidence): ProbeEvidence | undefined {
  if (!["known", "unknown", "unsupported"].includes(p.status)) return;
  return {
    status: p.status,
    sampledAtMs: number(p.sampledAtMs),
    durationMs: number(p.durationMs),
    outputBytes: number(p.outputBytes),
    reason: p.reason && reasons.has(p.reason) ? p.reason : undefined,
    ...(p.status === "known"
      ? {
          memoryPressure:
            p.memoryPressure && memoryStates.has(p.memoryPressure)
              ? p.memoryPressure
              : undefined,
          memoryLevel:
            p.memoryLevel !== undefined && [1, 2, 4].includes(p.memoryLevel)
              ? p.memoryLevel
              : undefined,
          kernelPressure:
            p.kernelPressure && kernelStates.has(p.kernelPressure)
              ? p.kernelPressure
              : undefined,
          kernelBytes: number(p.kernelBytes),
          kernelElements: number(p.kernelElements),
          kernelElementSize: number(p.kernelElementSize),
        }
      : {}),
  };
}
/** Rebuild the allowlist at persistence, even when a runtime caller supplies extras.
 * Invalid diagnostic data must never prevent the original stop from persisting. */
export function sanitizeStopDiagnostics(
  input: SafetyStopDiagnostics,
): SafetyStopDiagnostics | undefined {
  try {
    if (
      !sources.has(input.source) ||
      !actions.has(input.action) ||
      !["strict", "critical-only"].includes(input.policy) ||
      !Number.isSafeInteger(input.pid) ||
      input.pid < 1
    )
      return;
    const s = input.snapshot;
    const p = input.probes;
    return {
      source: input.source,
      action: input.action,
      policy: input.policy,
      pid: input.pid,
      reservationKind:
        input.reservationKind && kinds.has(input.reservationKind)
          ? input.reservationKind
          : undefined,
      reservationMb: number(input.reservationMb),
      snapshot: s
        ? {
            at: nullableNumber(s.at),
            completedAt: nullableNumber(s.completedAt),
            memoryPressure: memoryStates.has(s.memoryPressure)
              ? s.memoryPressure
              : "unknown",
            kernelPressure: kernelStates.has(s.kernelPressure)
              ? s.kernelPressure
              : "unknown",
            kernelBytes: nullableNumber(s.kernelBytes),
            aggregateFootprintMb: nullableNumber(s.aggregateFootprintMb),
            physicalFreeMb: nullableNumber(s.physicalFreeMb),
            swapUsedMb: nullableNumber(s.swapUsedMb),
          }
        : undefined,
      probes: p
        ? {
            memoryInitial: p.memoryInitial
              ? cleanProbe(p.memoryInitial)
              : undefined,
            kernel: p.kernel ? cleanProbe(p.kernel) : undefined,
            memoryFinal: p.memoryFinal ? cleanProbe(p.memoryFinal) : undefined,
          }
        : undefined,
    };
  } catch {
    return;
  }
}
function probeEvidence(
  p: KernelZoneProbeResult | MemoryPressureProbeResult,
): ProbeEvidence {
  return {
    status: p.status,
    sampledAtMs: p.sampledAtMs,
    durationMs: p.durationMs,
    outputBytes: p.outputBytes,
    ...(p.status !== "known"
      ? { reason: p.reason }
      : "usage" in p
        ? {
            kernelPressure: p.usage.pressure,
            kernelBytes: p.usage.bytes,
            kernelElements: p.usage.elements,
            kernelElementSize: p.usage.elementSize,
          }
        : { memoryPressure: p.pressure, memoryLevel: p.level }),
  };
}
export function probeStopDiagnostics(
  source: "daemon-pressure" | "worker-spawn",
  action: SafetyStopAction,
  policy: HostGuardPolicy,
  probes: PressureProbes,
): SafetyStopDiagnostics {
  return {
    source,
    action,
    policy,
    pid: process.pid,
    probes: {
      memoryInitial:
        probes.memoryInitial && probeEvidence(probes.memoryInitial),
      kernel: probes.kernel && probeEvidence(probes.kernel),
      memoryFinal: probes.memoryFinal && probeEvidence(probes.memoryFinal),
    },
  };
}
export function resourceStopDiagnostics(
  snapshot: HostResourceSnapshot,
  policy: HostGuardPolicy,
  action: "check" | "reserve",
  pid: number,
  kind?: string,
  mb?: number,
): SafetyStopDiagnostics {
  return {
    source: "resource-admission",
    action,
    policy,
    pid,
    snapshot: {
      at: snapshot.at,
      completedAt: snapshot.completedAt,
      memoryPressure: snapshot.memoryPressure,
      kernelPressure: snapshot.kernelPressure,
      kernelBytes: snapshot.kernelBytes,
      aggregateFootprintMb: snapshot.aggregateFootprintMb,
      physicalFreeMb: snapshot.physicalFreeMb,
      swapUsedMb: snapshot.swapUsedMb,
    },
    reservationKind: kind
      ? kinds.has(kind as ReservationKind)
        ? (kind as ReservationKind)
        : "other"
      : undefined,
    reservationMb: mb,
    probes: snapshot.pressureProbes
      ? probeStopDiagnostics(
          "daemon-pressure",
          "pressure-check",
          policy,
          snapshot.pressureProbes,
        ).probes
      : undefined,
  };
}

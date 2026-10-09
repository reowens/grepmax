import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { classifyZonePressure, parseZprintOutput } from "./kernel-zone";
import type { PressureProbes } from "./pressure-diagnostics";
import { parseFootprintMb } from "./process-footprint";

export interface ResourceProcess {
  pid: number;
  parentPid: number;
  groupPid: number;
  start: string;
  role: "daemon" | "mcp" | "worker" | "client" | "embedding" | "helper";
  footprintMb: number | null;
}
export interface HostResourceSnapshot {
  at: number;
  completedAt: number;
  platform: string;
  processes: ResourceProcess[];
  aggregateFootprintMb: number | null;
  physicalFreeMb: number | null;
  swapUsedMb: number | null;
  memoryPressure: "normal" | "warn" | "critical" | "unknown" | "unsupported";
  kernelPressure: "ok" | "warn" | "critical" | "unknown" | "unsupported";
  kernelBytes: number | null;
  incompleteReasons: string[];
  pressureProbes?: PressureProbes;
}
export interface ResourceSamplerDeps {
  platform: string;
  pid: number;
  uid: number;
  now: () => number;
  monotonic: () => number;
  freeBytes: () => number;
  run: (command: string, args: string[], timeoutMs: number) => string;
  sampleTimeoutMs: number;
  kernelProbeTimeoutMs: number;
}
export const HOST_SAMPLE_TIMEOUT_MS = 3000;
const MAX_PROCESSES = 64;
const PS_ARGS = ["-axo", "uid=,pid=,ppid=,pgid=,lstart=,comm="];
const ROLES: Record<string, ResourceProcess["role"]> = {
  "gmax-daemon": "daemon",
  "gmax-mcp": "mcp",
  "gmax-worker": "worker",
  "gmax-embed": "embedding",
  gmax: "client",
};

/** No argv/environment inspection. Include all same-user gmax clients, then
 * their entire child trees (uv launchers are not substitutes for Python). */
export function parseResourceProcesses(
  output: string,
  uid: number,
  selfPid: number,
  extraPids: readonly number[] = [],
  extraGroups: readonly number[] = [],
): ResourceProcess[] {
  const rows = output
    .trim()
    .split("\n")
    .map((line) => {
      const match =
        /^\s*(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
          line,
        );
      if (!match) throw new Error("process inventory could not be parsed");
      return {
        uid: Number(match[1]),
        pid: Number(match[2]),
        parentPid: Number(match[3]),
        groupPid: Number(match[4]),
        start: match[5].replace(/\s+/g, " "),
        command: path.basename(match[6].trim()),
      };
    })
    // ps sees itself as our child. It exits before footprint runs and is not
    // part of gmax's working set; including it makes every sample incomplete.
    .filter(
      (row) =>
        row.uid === uid && !(row.parentPid === selfPid && row.command === "ps"),
    );
  const selected = new Map<number, ResourceProcess>();
  for (const row of rows) {
    const role =
      ROLES[row.command] ??
      (row.pid === selfPid
        ? "client"
        : extraPids.includes(row.pid) || extraGroups.includes(row.groupPid)
          ? "embedding"
          : undefined);
    if (role)
      selected.set(row.pid, {
        pid: row.pid,
        parentPid: row.parentPid,
        groupPid: row.groupPid,
        start: row.start,
        role,
        footprintMb: null,
      });
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (selected.has(row.pid) || !selected.has(row.parentPid)) continue;
      selected.set(row.pid, {
        pid: row.pid,
        parentPid: row.parentPid,
        groupPid: row.groupPid,
        start: row.start,
        role: "helper",
        footprintMb: null,
      });
      added = true;
    }
  }
  if (!selected.has(selfPid))
    throw new Error("required process missing from inventory");
  if (selected.size > MAX_PROCESSES)
    throw new Error("process inventory exceeds 64 processes");
  return [...selected.values()].sort((a, b) => a.pid - b.pid);
}

export function parseBatchFootprints(output: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /\[(\d+)\]:.*\bFootprint:/.exec(line);
    if (!match) continue;
    const value = parseFootprintMb(line);
    const pid = Number(match[1]);
    if (value === null || value < 0 || result.has(pid))
      throw new Error("invalid process footprint");
    result.set(pid, value);
  }
  return result;
}

export function sampleHostResources(
  extraPids: readonly number[] = [],
  overrides: Partial<ResourceSamplerDeps> = {},
  extraGroups: readonly number[] = [],
): HostResourceSnapshot {
  const monotonic = overrides.monotonic ?? (() => performance.now());
  const deadline =
    monotonic() + (overrides.sampleTimeoutMs ?? HOST_SAMPLE_TIMEOUT_MS);
  let snapshot: HostResourceSnapshot;
  for (let attempt = 0; attempt < 2; attempt++) {
    snapshot = sampleHostResourcesOnce(
      extraPids,
      {
        ...overrides,
        monotonic,
        sampleTimeoutMs: Math.max(0, deadline - monotonic()),
      },
      extraGroups,
    );
    // Short-lived client children routinely exit during footprint sampling.
    // Re-measure the entire cohort once, within the original deadline. Never
    // accept a partial total or retry away observed warning/critical pressure.
    if (
      attempt === 1 ||
      snapshot.memoryPressure !== "normal" ||
      snapshot.kernelPressure !== "ok" ||
      snapshot.incompleteReasons.length !== 1 ||
      snapshot.incompleteReasons[0] !==
        "process inventory changed during sample" ||
      monotonic() >= deadline
    )
      return snapshot;
  }
  return snapshot!;
}

function sampleHostResourcesOnce(
  extraPids: readonly number[],
  overrides: Partial<ResourceSamplerDeps>,
  extraGroups: readonly number[],
): HostResourceSnapshot {
  const deps: ResourceSamplerDeps = {
    platform: process.platform,
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    now: Date.now,
    monotonic: () => performance.now(),
    freeBytes: os.freemem,
    sampleTimeoutMs: HOST_SAMPLE_TIMEOUT_MS,
    kernelProbeTimeoutMs: 500,
    run: (command, args, timeoutMs) =>
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ...overrides,
  };
  const snapshot: HostResourceSnapshot = {
    at: deps.now(),
    completedAt: deps.now(),
    platform: deps.platform,
    processes: [],
    aggregateFootprintMb: null,
    physicalFreeMb: null,
    swapUsedMb: null,
    memoryPressure: deps.platform === "darwin" ? "unknown" : "unsupported",
    kernelPressure: deps.platform === "darwin" ? "unknown" : "unsupported",
    kernelBytes: null,
    incompleteReasons: [],
  };
  if (deps.platform !== "darwin") return snapshot;
  const deadline = deps.monotonic() + deps.sampleTimeoutMs;
  const run = (command: string, args: string[], maximumMs = 500): string => {
    const remaining = Math.floor(deadline - deps.monotonic());
    if (remaining <= 0) throw new Error("resource sample deadline exceeded");
    return deps.run(command, args, Math.min(maximumMs, remaining));
  };
  try {
    const bytes = deps.freeBytes();
    if (Number.isFinite(bytes) && bytes >= 0)
      snapshot.physicalFreeMb = bytes / 1048576;
  } catch {}
  try {
    const zone = parseZprintOutput(
      run("zprint", ["-L", "data.kalloc.1024"], deps.kernelProbeTimeoutMs),
    );
    if (zone) {
      const bytes = zone.elements * zone.elementSize;
      if (Number.isSafeInteger(bytes)) {
        snapshot.kernelBytes = bytes;
        snapshot.kernelPressure = classifyZonePressure(bytes);
      }
    }
  } catch {}
  try {
    const swap = /\bused\s*=\s*([\d.]+)([MG])/i.exec(
      run("sysctl", ["-n", "vm.swapusage"]),
    );
    if (swap) {
      const mb = Number(swap[1]) * (swap[2].toUpperCase() === "G" ? 1024 : 1);
      if (Number.isFinite(mb) && mb >= 0) snapshot.swapUsedMb = mb;
    }
  } catch {}
  try {
    snapshot.processes = parseResourceProcesses(
      run("ps", PS_ARGS),
      deps.uid,
      deps.pid,
      extraPids,
      extraGroups,
    );
    const footprints = parseBatchFootprints(
      run(
        "footprint",
        [
          "--noCategories",
          ...snapshot.processes.flatMap((p) => ["-p", String(p.pid)]),
        ],
        1500,
      ),
    );
    for (const p of snapshot.processes)
      p.footprintMb = footprints.get(p.pid) ?? null;
    const after = parseResourceProcesses(
      run("ps", PS_ARGS),
      deps.uid,
      deps.pid,
      extraPids,
      extraGroups,
    );
    const identity = (p: ResourceProcess) => [
      p.pid,
      p.parentPid,
      p.groupPid,
      p.start,
      p.role,
    ];
    if (
      JSON.stringify(after.map(identity)) !==
      JSON.stringify(snapshot.processes.map(identity))
    )
      throw new Error("process inventory changed during sample");
    if (snapshot.processes.some((p) => p.footprintMb === null))
      throw new Error("process footprint unavailable");
    snapshot.aggregateFootprintMb = snapshot.processes.reduce(
      (sum, p) => sum + p.footprintMb!,
      0,
    );
  } catch (error) {
    snapshot.incompleteReasons.push(
      error instanceof Error &&
        /^(process|required|resource)/.test(error.message)
        ? error.message
        : "process inventory or footprint unavailable",
    );
    snapshot.aggregateFootprintMb = null;
  }
  // Fresh cheap pressure check after the batch; an earlier normal value cannot
  // authorize a fork after pressure changes during native sampling.
  try {
    const raw = run("sysctl", [
      "-n",
      "kern.memorystatus_vm_pressure_level",
    ]).trim();
    snapshot.memoryPressure =
      raw === "1"
        ? "normal"
        : raw === "2"
          ? "warn"
          : raw === "4"
            ? "critical"
            : "unknown";
  } catch {}
  if (snapshot.memoryPressure === "unknown")
    snapshot.incompleteReasons.push("OS memory pressure unavailable");
  if (snapshot.kernelPressure === "unknown")
    snapshot.incompleteReasons.push("kernel pressure unavailable");
  if (snapshot.physicalFreeMb === null)
    snapshot.incompleteReasons.push("physical free pages unavailable");
  if (snapshot.swapUsedMb === null)
    snapshot.incompleteReasons.push("swap usage unavailable");
  snapshot.completedAt = deps.now();
  if (deps.monotonic() > deadline)
    snapshot.incompleteReasons.push("resource sample deadline exceeded");
  return snapshot;
}

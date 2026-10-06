import {
  type CompactionResult,
  parseCompactionResult,
} from "../store/compaction-result";
import type { DaemonResponse } from "./daemon-client";

export interface DoctorOptimizeReport {
  status: CompactionResult["status"] | "unverified";
  via: "daemon" | "in-process";
  reason?: string;
  result?: CompactionResult;
}

/** A live daemon's failed repair must never become a competing local rewrite. */
export async function runDoctorOptimize(
  send: () => Promise<DaemonResponse>,
  optimizeInProcess: () => Promise<CompactionResult>,
): Promise<DoctorOptimizeReport> {
  const response = await send();
  const result = parseCompactionResult(response.compaction);
  if (result) {
    return {
      status:
        !response.ok && result.status === "completed"
          ? "failed"
          : result.status,
      via: "daemon",
      reason:
        result.reason ?? (response.ok ? undefined : String(response.error)),
      result,
    };
  }
  if (response.ok) {
    return {
      status: "unverified",
      via: "daemon",
      reason:
        "daemon did not report a compaction outcome; restart it with the current gmax version",
    };
  }
  const reason = String(response.error ?? "unknown failure");
  // Socket errors are returned as exact errno codes by sendDaemonCommand.
  // An ENOENT inside a daemon's failure message is not proof it is absent.
  if (reason === "ECONNREFUSED" || reason === "ENOENT") {
    try {
      const local = await optimizeInProcess();
      return {
        status: local.status,
        via: "in-process",
        reason: local.reason,
        result: local,
      };
    } catch (error) {
      return { status: "failed", via: "in-process", reason: String(error) };
    }
  }
  return {
    status: reason.includes("unknown command") ? "skipped" : "failed",
    via: "daemon",
    reason,
  };
}

export function formatDoctorOptimize(
  report: DoctorOptimizeReport,
  agent: boolean,
): string {
  const reason = report.reason?.replace(/[\r\n\t]/g, " ").slice(0, 512);
  if (agent) {
    const r = report.result;
    return [
      `optimize`,
      `status=${report.status}`,
      `via=${report.via}`,
      ...(r ? [`attempts=${r.attempts}`, `elapsed_ms=${r.elapsedMs}`] : []),
      ...(typeof r?.bytesReclaimed === "number"
        ? [`bytes_reclaimed=${r.bytesReclaimed}`]
        : []),
      ...(typeof r?.netBytesReclaimed === "number"
        ? [`net_bytes_reclaimed=${r.netBytesReclaimed}`]
        : []),
      ...(typeof r?.cleanupPasses === "number"
        ? [`cleanup_passes=${r.cleanupPasses}`]
        : []),
      ...(reason ? [`reason=${reason}`] : []),
    ].join("\t");
  }
  if (report.status === "completed")
    return `ok  Optimize complete (${report.via})`;
  return `${report.status === "failed" ? "FAIL" : "WARN"}  Optimize ${report.status} (${report.via}): ${reason ?? "no outcome reported"}`;
}

import { describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../src/lib/store/compaction-result";
import { formatCompactionStatus } from "../src/lib/store/compaction-result";
import {
  formatDoctorOptimize,
  runDoctorOptimize,
} from "../src/lib/utils/doctor-optimize";

const completed: CompactionResult = {
  status: "completed",
  at: 123,
  attempts: 1,
  elapsedMs: 25,
  bytesReclaimed: 1024,
};

describe("doctor optimization outcomes", () => {
  it("gives MCP agents a timestamped outcome and tolerates older status replies", () => {
    expect(
      formatCompactionStatus({
        ...completed,
        status: "failed",
        reason: "conflict",
      }),
    ).toContain("Last compaction: failed at");
    expect(formatCompactionStatus(undefined)).toBeUndefined();
    expect(formatCompactionStatus({ status: "completed" })).toBeUndefined();
  });
  it.each(["completed", "skipped", "failed"] as const)(
    "preserves a daemon's %s outcome",
    async (status) => {
      const result = { ...completed, status, reason: "test reason" };
      const local = vi.fn(async () => completed);
      const report = await runDoctorOptimize(
        async () => ({ ok: status === "completed", compaction: result }),
        local,
      );
      expect(report).toMatchObject({ status, via: "daemon", result });
      expect(local).not.toHaveBeenCalled();
      expect(formatDoctorOptimize(report, true)).toContain(`status=${status}`);
      expect(formatDoctorOptimize(report, false).startsWith("ok")).toBe(
        status === "completed",
      );
    },
  );

  it.each(["ECONNREFUSED", "ENOENT"])(
    "uses the sole local writer for %s",
    async (error) => {
      const local = vi.fn(async () => ({
        ...completed,
        status: "skipped" as const,
        reason: "insufficient headroom",
      }));
      const report = await runDoctorOptimize(
        async () => ({ ok: false, error }),
        local,
      );
      expect(local).toHaveBeenCalledOnce();
      expect(report).toMatchObject({ status: "skipped", via: "in-process" });
      expect(formatDoctorOptimize(report, false)).not.toContain(
        "Optimize complete",
      );
    },
  );

  it.each([
    "timeout",
    "initializing",
    "unknown command",
    "ENOENT: missing fragment",
  ])("does not compete with a live daemon on %s", async (error) => {
    const local = vi.fn(async () => completed);
    const report = await runDoctorOptimize(
      async () => ({ ok: false, error }),
      local,
    );
    expect(local).not.toHaveBeenCalled();
    expect(report.status).not.toBe("completed");
  });

  it("treats an older daemon's bare ok reply as unverified", async () => {
    const local = vi.fn(async () => completed);
    const report = await runDoctorOptimize(async () => ({ ok: true }), local);
    expect(report.status).toBe("unverified");
    expect(formatDoctorOptimize(report, false)).toContain("WARN");
    expect(local).not.toHaveBeenCalled();
  });

  it("reports a local exception as a failed repair", async () => {
    const report = await runDoctorOptimize(
      async () => ({ ok: false, error: "ENOENT" }),
      async () => {
        throw new Error("permission denied");
      },
    );
    expect(report.status).toBe("failed");
    expect(formatDoctorOptimize(report, false)).toContain("FAIL");
  });
});

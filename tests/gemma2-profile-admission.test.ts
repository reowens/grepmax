import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-gemma-admission-")),
  );
  vi.stubEnv("GMAX_GEMMA_PROFILE", "1");
  vi.stubEnv("HOME", directory);
  vi.stubEnv("GMAX_HOME", path.join(directory, "profile"));
  vi.stubEnv("GMAX_NO_AUTOSTART", undefined);
  vi.resetModules();
  fs.mkdirSync(path.join(directory, "profile"));
  fs.mkdirSync(path.join(directory, ".gmax"));
  fs.writeFileSync(
    path.join(directory, "profile/config.json"),
    JSON.stringify({ modelTier: "gemma2", embedMode: "gpu", vectorDim: 768 }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(directory, { recursive: true, force: true });
});
it("blocks implicit and explicit daemon launch while admitting pressure-checked in-process work", async () => {
  const auto = await import("../src/lib/utils/autostart");
  expect(auto.autostartDisabledReason()).toBe("profile");
  expect(auto.isAutostartDisabled()).toBe(true);
  expect(auto.daemonStartDeniedReason()).toBeNull();
  const { ensureDaemonRunning } = await import(
    "../src/lib/utils/daemon-client"
  );
  expect(await ensureDaemonRunning()).toBe(false);
  const launcher = await import("../src/lib/utils/daemon-launcher");
  expect(await launcher.spawnDaemon()).toBeNull();
  await expect(launcher.spawnDaemonProcess()).rejects.toThrow(/Gemma profiles/);
  const { storeMutationDeniedReason } = await vi.importActual<
    typeof import("../src/lib/store/maintenance-policy")
  >("../src/lib/store/maintenance-policy");
  expect(storeMutationDeniedReason()).toBeNull();
  const { ResourceBudget } = await vi.importActual<
    typeof import("../src/lib/utils/resource-budget")
  >("../src/lib/utils/resource-budget");
  const sample = {
    at: Date.now(),
    completedAt: Date.now(),
    platform: "darwin",
    processes: [],
    aggregateFootprintMb: null,
    physicalFreeMb: null,
    swapUsedMb: null,
    memoryPressure: "normal" as const,
    kernelPressure: "ok" as const,
    kernelBytes: 1,
    incompleteReasons: [],
  };
  const budget = new ResourceBudget({
    platform: "darwin",
    policy: () => "critical-only",
    criticalSample: () => sample,
    quarantine: auto.daemonStartDeniedReason,
  });
  expect(budget.check()).toBe(sample);
  vi.stubEnv("GMAX_NO_AUTOSTART", "1");
  expect(() => budget.check()).toThrow(/quarantined/);
  expect(auto.autostartDisabledReason()).toBe("env");
  expect(storeMutationDeniedReason()).toContain("quarantined");
});
it.each(["autostart-disabled", "safety-stop.json"])(
  "preserves the machine-wide %s stop",
  async (marker) => {
    fs.writeFileSync(
      path.join(directory, ".gmax", marker),
      marker === "safety-stop.json"
        ? JSON.stringify({
            schemaVersion: 1,
            at: Date.now(),
            reason: "fixture critical pressure",
          })
        : "fixture",
    );
    const auto = await import("../src/lib/utils/autostart");
    expect(auto.daemonStartDeniedReason()).not.toBeNull();
    expect(auto.autostartDisabledReason()).not.toBe("profile");
    const { storeMutationDeniedReason } = await vi.importActual<
      typeof import("../src/lib/store/maintenance-policy")
    >("../src/lib/store/maintenance-policy");
    expect(storeMutationDeniedReason()).not.toBeNull();
    const launcher = await import("../src/lib/utils/daemon-launcher");
    expect(await launcher.spawnDaemon()).toBeNull();
  },
);

it("continues refusing a daemon when profile configuration is incomplete", async () => {
  fs.writeFileSync(path.join(directory, "profile/config.json"), "{");
  const auto = await import("../src/lib/utils/autostart");
  expect(auto.autostartDisabledReason()).toBe("profile");
  const { ensureDaemonRunning } = await import(
    "../src/lib/utils/daemon-client"
  );
  expect(await ensureDaemonRunning()).toBe(false);
  const { spawnDaemonProcess } = await import(
    "../src/lib/utils/daemon-launcher"
  );
  await expect(spawnDaemonProcess()).rejects.toThrow(/Gemma profiles/);
});

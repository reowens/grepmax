import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitPrune,
  assertRecoveryAdmission,
  createRecoveryBudget,
  PRUNE_METADATA_HEADROOM_BYTES,
} from "../src/lib/store/recovery-admission";
import type { ResourceBudget } from "../src/lib/utils/resource-budget";

vi.unmock("../src/lib/store/recovery-admission");
vi.unmock("../src/lib/utils/resource-budget");
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

describe("production prune admission", () => {
  let root: string;
  let store: string;
  let check: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let attach: ReturnType<typeof vi.fn>;
  let budget: ResourceBudget;
  beforeEach(() => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      bavail: 1024 ** 3,
      bsize: 1,
    } as any);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-recovery-admission-"));
    store = path.join(root, "lancedb");
    fs.mkdirSync(store);
    fs.writeFileSync(
      path.join(root, "autostart-disabled"),
      "operator containment",
    );
    check = vi.fn(() => ({ platform: "darwin", physicalFreeMb: 1024 }));
    release = vi.fn();
    attach = vi.fn();
    budget = { check, reserve: vi.fn(() => ({ attach, release })) } as any;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("requires persistent offline containment and never creates it", () => {
    fs.unlinkSync(path.join(root, "autostart-disabled"));
    expect(() => assertRecoveryAdmission(store, budget)).toThrow(
      "persistent autostart-disabled",
    );
    expect(check).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "autostart-disabled"))).toBe(false);
  });
  it.each([NaN, 0, PRUNE_METADATA_HEADROOM_BYTES - 1])(
    "refuses unknown/insufficient metadata disk headroom: %s",
    (bytes) => {
      vi.mocked(fs.statfsSync).mockReturnValue({
        bavail: bytes,
        bsize: 1,
      } as any);
      expect(() => assertRecoveryAdmission(store, budget)).toThrow(
        "disk headroom",
      );
      expect(check).not.toHaveBeenCalled();
    },
  );
  it("admits prune below rewrite/download headroom with a verified existing runtime", () => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      bavail: PRUNE_METADATA_HEADROOM_BYTES,
      bsize: 1,
    } as any);
    expect(() => assertRecoveryAdmission(store, budget)).not.toThrow();
  });
  it.each([
    null,
    { platform: "linux", physicalFreeMb: 4096 },
    { platform: "darwin", physicalFreeMb: null },
    { platform: "darwin", physicalFreeMb: -1 },
    { platform: "darwin", physicalFreeMb: NaN },
  ])("refuses unsupported/unknown physical admission", (sample) => {
    check.mockReturnValue(sample);
    expect(() => assertRecoveryAdmission(store, budget)).toThrow();
  });
  it.each([0, 64, 511])(
    "admits healthy low-free-page hosts through strict checks and a shared reservation: %s MiB",
    (physicalFreeMb) => {
      check.mockReturnValue({ platform: "darwin", physicalFreeMb });
      const admission = admitPrune(store, budget);
      expect(budget.check).toHaveBeenCalledTimes(2);
      expect(budget.reserve).toHaveBeenCalledWith(512, "prune-helper");
      admission.close();
      expect(release).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "warning pressure",
    "critical pressure",
    "unknown resources",
    "aggregate capacity exceeded",
  ])("low free pages cannot bypass the strict budget refusing %s", (reason) => {
    check.mockImplementation(() => {
      throw new Error(reason);
    });
    expect(() => admitPrune(store, budget)).toThrow(reason);
    expect(budget.reserve).not.toHaveBeenCalled();
  });
  it("reserves helper capacity and rechecks at launch, deletion and heartbeat", () => {
    const admission = admitPrune(store, budget);
    expect(budget.reserve).toHaveBeenCalledWith(512, "prune-helper");
    admission.start(123);
    expect(attach).toHaveBeenCalledWith(123);
    admission.approve();
    admission.check();
    admission.close();
    expect(check).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases a reservation if admission changes after reserving", () => {
    check
      .mockReturnValueOnce({ platform: "darwin", physicalFreeMb: 1024 })
      .mockImplementationOnce(() => {
        throw new Error("pressure changed");
      });
    expect(() => admitPrune(store, budget)).toThrow("pressure changed");
    expect(release).toHaveBeenCalledOnce();
  });
  it("uses recovery-specific strict policy without client reconnect or changing service config", () => {
    const real = createRecoveryBudget() as any;
    expect(real.deps.policy()).toBe("strict");
    expect(real.deps.requireClientRegistration).toBe(false);
  });
  it("honors the selected OS warning policy without disabling aggregate accounting", () => {
    vi.stubEnv("GMAX_HOST_GUARD_POLICY", "critical-only");
    const real = createRecoveryBudget() as any;
    expect(real.deps.policy()).toBe("strict");
    expect(real.deps.allowMemoryWarning()).toBe(true);
    vi.stubEnv("GMAX_HOST_GUARD_POLICY", "strict");
    expect(real.deps.allowMemoryWarning()).toBe(false);
    vi.stubEnv("GMAX_HOST_GUARD_POLICY", "unknown");
    expect(real.deps.allowMemoryWarning()).toBe(false);
  });
});

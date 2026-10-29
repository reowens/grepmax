import { describe, expect, it, vi } from "vitest";

vi.unmock("../src/lib/utils/cpu-capacity");

import { effectiveCpuCount } from "../src/lib/utils/cpu-capacity";

function environment(files: Record<string, string>, parallelism = 8) {
  return {
    platform: "linux" as const,
    parallelism,
    readText(file: string) {
      if (!(file in files)) throw new Error("controller unavailable");
      return files[file];
    },
  };
}

describe("effective CPU capacity", () => {
  it("honors a parent quota even when the leaf is unlimited", () => {
    const files = {
      "/proc/self/cgroup": "0::/team/service\n",
      "/sys/fs/cgroup/team/service/cpu.max": "max 100000",
      "/sys/fs/cgroup/team/cpu.max": "200000 100000",
      "/sys/fs/cgroup/cpu.max": "400000 100000",
    };
    expect(effectiveCpuCount(environment(files))).toBe(2);
    expect(effectiveCpuCount(environment(files, 1))).toBe(1);
  });

  it("rounds fractional quotas down without preventing single-CPU progress", () => {
    expect(
      effectiveCpuCount(
        environment({
          "/proc/self/cgroup": "0::/service",
          "/sys/fs/cgroup/service/cpu.max": "50000 100000",
        }),
      ),
    ).toBe(1);
    expect(
      effectiveCpuCount(
        environment({
          "/proc/self/cgroup": "0::/service",
          "/sys/fs/cgroup/service/cpu.max": "250000 100000",
        }),
      ),
    ).toBe(2);
  });

  it("takes the tightest quota across the leaf and all visible ancestors", () => {
    expect(
      effectiveCpuCount(
        environment({
          "/proc/self/cgroup": "0::/team/service",
          "/sys/fs/cgroup/team/service/cpu.max": "600000 100000",
          "/sys/fs/cgroup/team/cpu.max": "400000 100000",
          "/sys/fs/cgroup/cpu.max": "300000 100000",
        }),
      ),
    ).toBe(3);
  });

  it.each([
    "max 100000",
    "0 100000",
    "200000 0",
    "bad",
    "2.5 1",
    "9007199254740992 1",
  ])(
    "ignores an unlimited or malformed leaf quota (%s) while checking ancestors",
    (quota) => {
      expect(
        effectiveCpuCount(
          environment({
            "/proc/self/cgroup": "0::/team/service",
            "/sys/fs/cgroup/team/service/cpu.max": quota,
            "/sys/fs/cgroup/team/cpu.max": "200000 100000",
          }),
        ),
      ).toBe(2);
    },
  );

  it("handles root membership and rejects unsafe or non-unified membership", () => {
    expect(
      effectiveCpuCount(
        environment({
          "/proc/self/cgroup": "0::/\n",
          "/sys/fs/cgroup/cpu.max": "200000 100000",
        }),
      ),
    ).toBe(2);
    for (const membership of ["0::relative", "0::/../service", "2:cpu:/service"]) {
      const readText = vi.fn(
        environment({ "/proc/self/cgroup": membership }).readText,
      );
      expect(
        effectiveCpuCount({ platform: "linux", parallelism: 8, readText }),
      ).toBe(8);
      expect(readText.mock.calls).toEqual([["/proc/self/cgroup"]]);
    }
  });

  it("uses remaining ancestors or affinity when metadata is unavailable", () => {
    expect(
      effectiveCpuCount(
        environment({
          "/proc/self/cgroup": "0::/team/service",
          "/sys/fs/cgroup/team/cpu.max": "200000 100000",
        }),
      ),
    ).toBe(2);
    expect(effectiveCpuCount(environment({}, 3))).toBe(3);
  });

  it("uses affinity on other platforms without reading Linux controller files", () => {
    const readText = vi.fn(() => {
      throw new Error("unexpected Linux read");
    });
    expect(
      effectiveCpuCount({ platform: "darwin", parallelism: 6, readText }),
    ).toBe(6);
    expect(readText).not.toHaveBeenCalled();
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("scripts/postrelease.sh"), "utf8");
const probe = source.match(
  /daemon_start_denied\(\) \{\n {2}node <<'NODE'\n([\s\S]*?)\nNODE\n\}/,
)?.[1];
if (!probe) throw new Error("Release quarantine probe is missing");

function denied(
  markers: string[] = [],
  env: Record<string, string> = {},
  failure?: string,
): boolean {
  let code: number | undefined;
  const stopped = {};
  const filesystem = {
    lstatSync(file: string) {
      if (failure)
        throw Object.assign(new Error("probe failed"), { code: failure });
      if (markers.includes(file)) return {};
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  };
  try {
    vm.runInNewContext(
      probe as string,
      {
        require(name: string) {
          if (name === "node:fs") return filesystem;
          if (name === "node:os") return { homedir: () => "/fixture/home" };
          if (name === "node:path") return path;
          throw new Error(`Unexpected probe dependency: ${name}`);
        },
        process: {
          env,
          exit(value: number) {
            code = value;
            throw stopped;
          },
        },
      },
      { timeout: 100 },
    );
  } catch (error) {
    if (error !== stopped) throw error;
  }
  if (code === undefined) throw new Error("Probe did not return a decision");
  return code === 0;
}

describe("release handoff preserves quarantine", () => {
  it("permits handoff only when every marker is absent", () => {
    expect(denied()).toBe(false);
  });
  it.each(["autostart-disabled", "safety-stop.json"])(
    "honors machine-wide %s with a custom store",
    (name) => {
      expect(
        denied([`/fixture/home/.gmax/${name}`], {
          GMAX_HOME: "/fixture/secondary",
        }),
      ).toBe(true);
    },
  );
  it("honors the custom store marker", () => {
    expect(
      denied(["/fixture/secondary/autostart-disabled"], {
        GMAX_HOME: "/fixture/secondary",
      }),
    ).toBe(true);
  });
  it("honors the environment kill switch", () => {
    expect(denied([], { GMAX_NO_AUTOSTART: "1" })).toBe(true);
  });
  it.each(["EACCES", "EIO"])(
    "refuses handoff on %s instead of assuming absence",
    (failure) => {
      expect(denied([], {}, failure)).toBe(true);
    },
  );
});

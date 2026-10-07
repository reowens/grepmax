import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("recovery CLI dispatch", () => {
  let root: string, table: string;
  const bin = path.resolve(__dirname, "../src/bin.ts");
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-recover-cli-"));
    table = path.join(root, ".gmax/lancedb/chunks.lance");
    fs.mkdirSync(table, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(args: string[]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      GMAX_HOME: "",
    };
    delete env.GMAX_STORE;
    return spawnSync(process.execPath, ["--import", "tsx", bin, ...args], {
      cwd: path.dirname(bin),
      env,
      encoding: "utf8",
      timeout: 10000,
    });
  }

  it.each([["--store", "recover"], ["--store=recover"], []])(
    "routes recovery after root options %j to admission",
    (...prefix) => {
      for (const version of [["--version", "1"], ["--version=1"]]) {
        const result = run([
          ...prefix,
          "recover",
          "--table",
          table,
          "--prune",
          ...version,
          "--cutoff",
          "2020-01-01T00:00:00Z",
          "--json",
        ]);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout).toBe(1);
        expect(JSON.parse(result.stderr)).toMatchObject({
          outcome: "refused",
          error: expect.stringContaining("autostart-disabled"),
        });
        expect(
          fs.existsSync(
            path.join(path.dirname(table), ".gmax-prune-state.json"),
          ),
        ).toBe(false);
      }
    },
    30000,
  );

  it("keeps root package-version output with a command name as store value", () => {
    const result = run(["--store", "recover", "--version"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("uses the explicit recovery table without seeding a routed store", () => {
    const target = path.join(root, "project");
    const secondary = path.join(root, "secondary-home");
    fs.writeFileSync(
      path.join(root, ".gmax/stores.json"),
      JSON.stringify({ stores: [{ prefix: target, home: secondary }] }),
    );
    fs.writeFileSync(path.join(root, ".gmax/config.json"), "{}");
    const result = run([
      "--store",
      target,
      "recover",
      "--table",
      table,
      "--json",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "status",
      table: fs.realpathSync(table),
      state: null,
    });
    expect(fs.existsSync(secondary)).toBe(false);
  });
});

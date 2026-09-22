import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandTarget } from "../src/bin";
import { matchStore, readStores, volumeOf } from "../src/lib/utils/stores";

let tmp: string;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmax-stores-")));
  const drive = path.join(tmp, "drive", "packages");
  fs.mkdirSync(path.join(drive, "codenotch", "Sources"), { recursive: true });
  const link = path.join(tmp, "Development", "packages");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(drive, link);
  const store = { prefix: drive, home: path.join(tmp, "drive", ".gmax-store") };
  return { drive, link, store };
}

describe("matchStore", () => {
  it("routes a project under a store prefix to that store", () => {
    const { drive, store } = setup();
    expect(matchStore(path.join(drive, "codenotch"), [store])).toEqual({ kind: "store", store });
  });

  it("matches through a symlink to the drive", () => {
    const { link, store } = setup();
    expect(matchStore(path.join(link, "codenotch", "Sources"), [store])).toEqual({ kind: "store", store });
  });

  it("leaves everything else on the primary store", () => {
    const { store } = setup();
    expect(matchStore(path.join(tmp, "Development"), [store])).toEqual({ kind: "primary" });
    expect(matchStore("/anywhere", [])).toEqual({ kind: "primary" });
  });

  it("reports a store whose volume is not mounted as offline", () => {
    const store = { prefix: "/Volumes/NoSuchDrive-gmax-test/packages", home: "/Volumes/NoSuchDrive-gmax-test/.gmax-store" };
    expect(matchStore("/Volumes/NoSuchDrive-gmax-test/packages/pock", [store])).toEqual({
      kind: "offline",
      store,
      volume: "/Volumes/NoSuchDrive-gmax-test",
    });
  });

  it("follows a dangling symlink to name the offline store", () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmax-stores-")));
    const link = path.join(tmp, "packages");
    fs.symlinkSync("/Volumes/NoSuchDrive-gmax-test/packages", link);
    const store = { prefix: "/Volumes/NoSuchDrive-gmax-test/packages", home: "/Volumes/NoSuchDrive-gmax-test/.gmax-store" };
    expect(matchStore(path.join(link, "pock"), [store]).kind).toBe("offline");
  });
});

describe("readStores and volumeOf", () => {
  it("reads valid entries and ignores a missing or malformed file", () => {
    const { store } = setup();
    const file = path.join(tmp, "stores.json");
    expect(readStores(file)).toEqual([]);
    fs.writeFileSync(file, "{not json");
    expect(readStores(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ stores: [store, { prefix: 1 }] }));
    expect(readStores(file)).toEqual([store]);
  });

  it("names the volume only for /Volumes paths", () => {
    expect(volumeOf("/Volumes/External/dev/packages")).toBe("/Volumes/External");
    expect(volumeOf("/Users/x/.gmax")).toBeNull();
  });
});

describe("commandTarget", () => {
  it("prefers --root and --store, then index --path, then a directory argument, then cwd", () => {
    expect(commandTarget(["search", "q", "--root", "/a/b"], "/cwd")).toBe("/a/b");
    expect(commandTarget(["search", "q", "--store=/a/c"], "/cwd")).toBe("/a/c");
    expect(commandTarget(["index", "--path", "rel"], "/cwd")).toBe("/cwd/rel");
    expect(commandTarget(["add", "/x/y"], "/cwd")).toBe("/x/y");
    expect(commandTarget(["search", "some query"], "/cwd")).toBe("/cwd");
  });
});

describe("secondary store autostart", () => {
  it("keeps the autostart gate closed and says why", async () => {
    const { autostartDisabledNotice } = await import("../src/lib/utils/autostart");
    process.env.GMAX_SECONDARY_STORE = "1";
    try {
      expect(autostartDisabledNotice()).toMatch(/external drive — running in-process, not watched/);
    } finally {
      delete process.env.GMAX_SECONDARY_STORE;
    }
  });
});

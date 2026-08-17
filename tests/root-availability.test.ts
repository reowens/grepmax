import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRoot,
  describeRoot,
  isRootUnavailable,
} from "../src/lib/utils/root-availability";

/** Paths the mocked fs reports as existing. */
const existingPaths = new Set<string>();
/** Paths that throw a non-ENOENT error, e.g. a hung network share. */
const erroringPaths = new Map<string, string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...(actual as any),
    statSync: vi.fn((p: string) => {
      const key = String(p);
      const code = erroringPaths.get(key);
      if (code) throw Object.assign(new Error(code), { code });
      if (existingPaths.has(key)) return {} as any;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
});

/** Present exactly these paths as existing. */
function onlyTheseExist(present: string[]): void {
  existingPaths.clear();
  for (const p of present) existingPaths.add(p);
}

describe("project root availability", () => {
  beforeEach(() => {
    existingPaths.clear();
    erroringPaths.clear();
  });

  it("reports a directory that exists as present", () => {
    onlyTheseExist(["/Users/reoiv/dev/proj"]);

    expect(classifyRoot("/Users/reoiv/dev/proj")).toBe("present");
    expect(isRootUnavailable("/Users/reoiv/dev/proj")).toBe(false);
    expect(describeRoot("/Users/reoiv/dev/proj")).toBe("available");
  });

  it("treats an unmounted macOS volume as unavailable, not missing", () => {
    // The real reported case: /Volumes exists, the drive under it does not.
    onlyTheseExist(["/Volumes"]);

    const root = "/Volumes/External/dev-projects/cokemusic/furni";
    expect(classifyRoot(root)).toBe("unavailable");
    expect(isRootUnavailable(root)).toBe(true);
    expect(describeRoot(root)).toBe("volume not mounted");
  });

  it("treats a deleted directory on a mounted volume as missing", () => {
    // Drive is plugged in and its tree is intact up to the project itself.
    onlyTheseExist([
      "/Volumes",
      "/Volumes/External",
      "/Volumes/External/dev-projects",
    ]);

    const root = "/Volumes/External/dev-projects/cokemusic/furni";
    expect(classifyRoot(root)).toBe("missing");
    expect(isRootUnavailable(root)).toBe(false);
    expect(describeRoot(root)).toBe("directory not found");
  });

  it("treats an absent path on ordinary internal storage as missing", () => {
    onlyTheseExist(["/Users/reoiv/dev"]);

    expect(classifyRoot("/Users/reoiv/dev/deleted-project")).toBe("missing");
  });

  it("does not let /media shadow the longer /run/media container", () => {
    // /run/media/<user> exists (the user is logged in) but the volume is gone.
    onlyTheseExist(["/run", "/run/media", "/run/media/reoiv"]);

    expect(classifyRoot("/run/media/reoiv/Backup/proj")).toBe("unavailable");
  });

  it("classifies a mounted /run/media volume with a deleted project as missing", () => {
    onlyTheseExist([
      "/run/media",
      "/run/media/reoiv",
      "/run/media/reoiv/Backup",
    ]);

    expect(classifyRoot("/run/media/reoiv/Backup/proj")).toBe("missing");
  });

  it("handles other mount containers", () => {
    onlyTheseExist(["/mnt"]);
    expect(classifyRoot("/mnt/data/proj")).toBe("unavailable");

    onlyTheseExist(["/mnt", "/mnt/data"]);
    expect(classifyRoot("/mnt/data/proj")).toBe("missing");
  });

  it("does not classify a path too shallow to name a mount point", () => {
    onlyTheseExist([]);
    // /Volumes itself is not a project on a volume; there is nothing to keep.
    expect(classifyRoot("/Volumes")).toBe("missing");
  });

  it("treats an unreadable network mount as unavailable rather than deleted", () => {
    // A hung share can throw EIO instead of ENOENT; the container check, not
    // the errno, is what decides.
    onlyTheseExist(["/net"]);
    erroringPaths.set("/net/fileserver", "EIO");
    erroringPaths.set("/net/fileserver/repo", "EIO");

    expect(classifyRoot("/net/fileserver/repo")).toBe("unavailable");
  });
});

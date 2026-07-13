import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const skeletonizeFile = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/skeleton", () => ({
  Skeletonizer: class {
    init = vi.fn(async () => {});
    skeletonizeFile = skeletonizeFile;
  },
}));

vi.mock("../src/lib/skeleton/retriever", () => ({
  getStoredSkeleton: vi.fn(async () => null),
}));

import { outputSkeletons } from "../src/commands/search-skeletons";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  skeletonizeFile.mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("search skeleton containment", () => {
  it.each([
    "poisoned outside path",
    "post-index symlink replacement",
  ])("marks a %s unreadable without opening it", async (scenario) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-skeleton-"));
    tempDirs.push(parent);
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.ts");
    fs.writeFileSync(secret, "DO_NOT_DISCLOSE");
    const indexed = path.join(root, "source.ts");
    if (scenario === "post-index symlink replacement") {
      fs.writeFileSync(indexed, "safe");
      fs.unlinkSync(indexed);
      fs.symlinkSync(secret, indexed);
    }
    const poisoned = scenario === "poisoned outside path" ? secret : indexed;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await outputSkeletons([{ metadata: { path: poisoned } }], root, 1, null);

    expect(skeletonizeFile).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("File not readable");
    expect(log.mock.calls.flat().join("\n")).not.toContain("DO_NOT_DISCLOSE");
  });
});

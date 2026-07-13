import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectFilePolicy } from "../src/lib/index/file-policy";
import {
  createWalkState,
  isPathProtectedByWalkState,
  walk,
} from "../src/lib/index/walker";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-walk-state-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("walker completeness", () => {
  it("marks a root classification failure as globally incomplete", async () => {
    const root = tempRoot();
    const error = new Error("EACCES");
    const policy = {
      classifyDirectory: async () => ({
        status: "error",
        error,
        protectedPath: root,
      }),
    } as unknown as ProjectFilePolicy;
    const state = createWalkState();

    const files: string[] = [];
    for await (const file of walk(root, { policy, state })) files.push(file);

    expect(files).toEqual([]);
    expect(state.rootComplete).toBe(false);
    expect(isPathProtectedByWalkState(path.join(root, "any.ts"), state)).toBe(
      true,
    );
  });

  it("protects only a failed nested subtree", async () => {
    const root = tempRoot();
    const failed = path.join(root, "failed");
    const healthy = path.join(root, "healthy");
    fs.mkdirSync(failed);
    fs.mkdirSync(healthy);
    fs.writeFileSync(path.join(failed, "old.ts"), "old");
    fs.writeFileSync(path.join(healthy, "live.ts"), "live");
    const policy = {
      classifyDirectory: async (candidate: string) =>
        candidate === failed
          ? {
              status: "error",
              error: new Error("EIO"),
              protectedPath: failed,
            }
          : { status: "traverse" },
      classifyFile: async () => ({
        status: "indexable",
        stat: {} as fs.Stats,
      }),
    } as unknown as ProjectFilePolicy;
    const state = createWalkState();
    const files: string[] = [];

    for await (const file of walk(root, { policy, state })) files.push(file);

    expect(files).toEqual([path.join("healthy", "live.ts")]);
    expect(state.rootComplete).toBe(true);
    expect(isPathProtectedByWalkState(path.join(failed, "old.ts"), state)).toBe(
      true,
    );
    expect(
      isPathProtectedByWalkState(path.join(healthy, "stale.ts"), state),
    ).toBe(false);
  });
});

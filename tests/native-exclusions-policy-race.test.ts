import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@parcel/watcher", () => ({ subscribe: vi.fn() }));

import * as watcher from "@parcel/watcher";
import { subscribeWithNativeExclusions } from "../src/lib/index/watcher-ignore";

const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gmax-exclusion-race-")),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "scratch"));
  return root;
}
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
describe("policy changes during native subscription", () => {
  it("removes a stale exclusion when the policy changes before the listener attaches", async () => {
    const root = await fixture();
    const file = path.join(root, ".gitignore");
    await fs.writeFile(file, "scratch/\n");
    const unsubscribe = vi.fn(async () => {});
    vi.mocked(watcher.subscribe)
      .mockImplementationOnce(async () => {
        await fs.writeFile(file, "scratch/\n!scratch/\n");
        return { unsubscribe };
      })
      .mockResolvedValue({ unsubscribe: vi.fn(async () => {}) });
    const result = await subscribeWithNativeExclusions(root, () => {}, [
      "**/node_modules/**",
    ]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(watcher.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(watcher.subscribe).mock.calls[0][2]?.ignore).toContain(
      "scratch",
    );
    expect(vi.mocked(watcher.subscribe).mock.calls[1][2]?.ignore).not.toContain(
      "scratch",
    );
    await result.subscription.unsubscribe();
  });
  it("bounds repeated policy churn and falls back to immutable filtering", async () => {
    const root = await fixture();
    const file = path.join(root, ".gmaxignore");
    await fs.writeFile(file, "scratch/**\n");
    const closed = vi.fn(async () => {});
    let calls = 0;
    vi.mocked(watcher.subscribe).mockImplementation(async () => {
      calls++;
      await fs.writeFile(file, calls % 2 ? "other/**\n" : "scratch/**\n");
      return { unsubscribe: closed };
    });
    const base = ["**/node_modules/**"];
    const result = await subscribeWithNativeExclusions(root, () => {}, base);
    expect(watcher.subscribe).toHaveBeenCalledTimes(3);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(vi.mocked(watcher.subscribe).mock.calls[2][2]?.ignore).toEqual(base);
    await result.subscription.unsubscribe();
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncSubscription, SubscribeCallback } from "@parcel/watcher";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@parcel/watcher", () => ({ subscribe: vi.fn() }));

import * as watcher from "@parcel/watcher";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";
import {
  reconcileProject,
  WatcherSubscription,
} from "../src/lib/index/watcher-core";
import { WatcherRecoveryTracker } from "../src/lib/index/watcher-recovery";

describe("WatcherSubscription", () => {
  let root: string;
  let callbacks: SubscribeCallback[];
  let unsubscribes: Array<ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gmax-watcher-core-"));
    callbacks = [];
    unsubscribes = [];
    vi.mocked(watcher.subscribe)
      .mockReset()
      .mockImplementation(async (_root, callback) => {
        callbacks.push(callback);
        const unsubscribe = vi.fn(async () => {});
        unsubscribes.push(unsubscribe);
        return { unsubscribe };
      });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function create(overrides: Partial<{ active: () => boolean }> = {}) {
    const recovery = new WatcherRecoveryTracker();
    const handlers = {
      onError: vi.fn(),
      onGap: vi.fn(),
      onTerminal: vi.fn(),
      onEvents: vi.fn(),
    };
    const subscription = new WatcherSubscription({
      root,
      recovery,
      isActive: overrides.active ?? (() => true),
      ...handlers,
    });
    return { subscription, recovery, ...handlers };
  }

  it("skips an update whose ignore identity is unchanged and replaces one that changed", async () => {
    const policy = path.join(root, ".gmaxignore");
    await fs.writeFile(policy, "/artifacts/\n");
    const { subscription, recovery } = create();

    await subscription.update();
    await subscription.update();
    expect(watcher.subscribe).toHaveBeenCalledOnce();
    expect(recovery.snapshot().exclusions?.attached).toBe(true);

    await fs.writeFile(policy, "/other/\n");
    await subscription.update();
    expect(watcher.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(vi.mocked(watcher.subscribe).mock.calls[1][2]?.ignore).toContain(
      "other/**",
    );
  });

  it("routes gaps and terminal errors, and subscribes again only after a terminal error", async () => {
    const { subscription, recovery, onError, onGap, onTerminal, onEvents } =
      create();
    await subscription.update();

    const gap = new Error(
      "Events were dropped by the kernel. File system must be re-scanned.",
    );
    callbacks[0](gap, [{ type: "update", path: `${root}/a.ts` }]);
    expect(onError).toHaveBeenCalledWith(gap);
    expect(onGap).toHaveBeenCalledWith(gap);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onEvents).toHaveBeenCalledWith([
      { type: "update", path: `${root}/a.ts` },
    ]);
    expect(subscription.failed).toBe(false);
    await subscription.update();
    expect(watcher.subscribe).toHaveBeenCalledOnce();

    const terminal = new Error("backend stopped");
    callbacks[0](terminal, []);
    expect(onTerminal).toHaveBeenCalledWith(terminal);
    expect(onEvents).toHaveBeenLastCalledWith([]);
    expect(subscription.failed).toBe(true);
    expect(recovery.snapshot()).toMatchObject({
      gapCount: 1,
      terminalErrorCount: 1,
    });

    await subscription.update();
    expect(watcher.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(subscription.failed).toBe(false);

    // The replaced stream's callback no longer reaches the owner.
    callbacks[0](terminal, [{ type: "update", path: `${root}/b.ts` }]);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("disposes a subscribe that finishes after retire and drops its events", async () => {
    let finish!: (value: AsyncSubscription) => void;
    vi.mocked(watcher.subscribe).mockImplementationOnce(
      async (_root, callback) => {
        callbacks.push(callback);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { subscription, recovery, onEvents } = create();
    const updating = subscription.update();
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledOnce());
    subscription.retire();
    const unsubscribe = vi.fn(async () => {});
    finish({ unsubscribe });
    await updating;
    await subscription.settled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(recovery.snapshot().exclusions).toBeUndefined();
    callbacks[0](null, [{ type: "update", path: `${root}/a.ts` }]);
    expect(onEvents).not.toHaveBeenCalled();
    await subscription.update();
    expect(watcher.subscribe).toHaveBeenCalledOnce();
  });

  it("does not subscribe for an inactive owner", async () => {
    const { subscription } = create({ active: () => false });
    await subscription.update();
    expect(watcher.subscribe).not.toHaveBeenCalled();
  });
});

describe("reconcileProject", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gmax-reconcile-"));
    await fs.writeFile(path.join(root, "kept.ts"), "export const a = 1;\n");
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(
      path.join(root, "node_modules", "dep.ts"),
      "export const b = 1;\n",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function stores(known: string[]) {
    return {
      metaCache: {
        getKeysWithPrefix: vi.fn(async () => new Set(known)),
      } as any,
      vectorDb: {
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
      } as any,
    };
  }

  it("visits policy-admitted files and purges known paths the walk did not see", async () => {
    const kept = path.join(root, "kept.ts");
    const gone = path.join(root, "gone.ts");
    const processor = { handleFileEvent: vi.fn() } as any;
    const visited: string[] = [];
    const result = await reconcileProject({
      root,
      policy: new ProjectFilePolicy(root),
      processor,
      ...stores([kept, gone]),
      aborted: () => false,
      visit: async ({ absolute }) => {
        visited.push(absolute);
        return true;
      },
    });
    expect(visited).toEqual([kept]);
    expect(result).toMatchObject({ complete: true, seen: 1, purged: 1 });
    expect(processor.handleFileEvent).toHaveBeenCalledExactlyOnceWith(
      "unlink",
      gone,
      { forceDelete: true, workKind: "cleanup" },
    );
  });

  it("purges a visited file that the visitor reports absent", async () => {
    const kept = path.join(root, "kept.ts");
    const processor = { handleFileEvent: vi.fn() } as any;
    const result = await reconcileProject({
      root,
      policy: new ProjectFilePolicy(root),
      processor,
      ...stores([kept]),
      aborted: () => false,
      visit: async () => false,
    });
    expect(result).toMatchObject({ seen: 0, purged: 1 });
  });

  it("returns null without purging once aborted", async () => {
    const processor = { handleFileEvent: vi.fn() } as any;
    const result = await reconcileProject({
      root,
      policy: new ProjectFilePolicy(root),
      processor,
      ...stores([path.join(root, "gone.ts")]),
      aborted: () => true,
      visit: async () => true,
    });
    expect(result).toBeNull();
    expect(processor.handleFileEvent).not.toHaveBeenCalled();
  });
});

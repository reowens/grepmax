import { describe, expect, it, vi } from "vitest";
import { KeyedMutex } from "../src/lib/utils/keyed-mutex";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("KeyedMutex", () => {
  it("serializes the same key while allowing different keys", async () => {
    const mutex = new KeyedMutex();
    const release = deferred();
    const events: string[] = [];
    const first = mutex.run("a", undefined, async () => {
      events.push("a1:start");
      await release.promise;
      events.push("a1:end");
    });
    const second = mutex.run("a", undefined, async () => {
      events.push("a2");
    });
    const other = mutex.run("b", undefined, async () => {
      events.push("b");
    });

    await vi.waitFor(() => expect(events).toContain("b"));
    expect(events).not.toContain("a2");
    release.resolve();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["a1:start", "b", "a1:end", "a2"]);
  });

  it("removes an aborted waiter before the holder releases", async () => {
    const mutex = new KeyedMutex();
    const release = deferred();
    const holder = mutex.run("a", undefined, async () => release.promise);
    const ac = new AbortController();
    const queued = mutex.run("a", ac.signal, async () => {
      throw new Error("must not run");
    });
    ac.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await holder;
    expect(mutex.pending).toBe(0);
  });
});

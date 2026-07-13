import { describe, expect, it, vi } from "vitest";
import {
  OperationBusyError,
  OperationClosedError,
  OperationCoordinator,
} from "../src/lib/utils/operation-coordinator";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("OperationCoordinator", () => {
  it("allows shared operations to overlap", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    let active = 0;
    let peak = 0;
    const run = () =>
      coordinator.runShared("search", undefined, async () => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
      });

    const first = run();
    const second = run();
    await vi.waitFor(() => expect(peak).toBe(2));
    release.resolve();
    await Promise.all([first, second]);
  });

  it("blocks new shared admission as soon as exclusive intent exists", async () => {
    const coordinator = new OperationCoordinator();
    const sharedRelease = deferred();
    const quiesced = deferred();
    const shared = coordinator.runShared("search", undefined, async () => {
      await sharedRelease.promise;
    });
    const exclusive = coordinator.runExclusive(
      "repair",
      async () => {
        quiesced.resolve();
      },
      async () => {},
    );
    await quiesced.promise;

    await expect(
      coordinator.runShared("search", undefined, async () => {}),
    ).rejects.toBeInstanceOf(OperationBusyError);
    sharedRelease.resolve();
    await Promise.all([shared, exclusive]);
  });

  it("quiesces before waiting for admitted shared work to drain", async () => {
    const coordinator = new OperationCoordinator();
    const sharedRelease = deferred();
    const events: string[] = [];
    const shared = coordinator.runShared("search", undefined, async () => {
      events.push("shared:start");
      await sharedRelease.promise;
      events.push("shared:end");
    });
    const exclusive = coordinator.runExclusive(
      "repair",
      async () => {
        events.push("quiesce");
      },
      async () => {
        events.push("exclusive");
      },
    );
    await vi.waitFor(() => expect(events).toContain("quiesce"));
    expect(events).toEqual(["shared:start", "quiesce"]);
    sharedRelease.resolve();
    await Promise.all([shared, exclusive]);
    expect(events).toEqual([
      "shared:start",
      "quiesce",
      "shared:end",
      "exclusive",
    ]);
  });

  it("admits only one exclusive request", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    const first = coordinator.runExclusive(
      "repair",
      async () => {},
      async () => release.promise,
    );

    await expect(
      coordinator.runExclusive(
        "other",
        async () => {},
        async () => {},
      ),
    ).rejects.toBeInstanceOf(OperationBusyError);
    release.resolve();
    await first;
  });

  it("close aborts active work, rejects new work, and is single-flight", async () => {
    const coordinator = new OperationCoordinator();
    const observedAbort = deferred();
    const active = coordinator.runShared(
      "search",
      undefined,
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    const firstClose = coordinator.close();
    const secondClose = coordinator.close();
    expect(firstClose).toBe(secondClose);
    await observedAbort.promise;
    await Promise.all([active, firstClose]);
    await expect(
      coordinator.runShared("search", undefined, async () => {}),
    ).rejects.toBeInstanceOf(OperationClosedError);
  });
});

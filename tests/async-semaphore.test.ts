import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEAVY_READ_CONCURRENCY,
  isHeavyReadVerb,
  resolveHeavyReadConcurrency,
  runReadVerb,
} from "../src/lib/daemon/read-verbs";
import {
  AsyncSemaphore,
  mapWithConcurrency,
} from "../src/lib/utils/async-semaphore";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("AsyncSemaphore", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new AsyncSemaphore(0)).toThrow(RangeError);
    expect(() => new AsyncSemaphore(1.5)).toThrow(RangeError);
  });

  it("never runs more than capacity tasks at once, and runs them all", async () => {
    const sem = new AsyncSemaphore(2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const runs = gates.map((gate, i) =>
      sem.run(undefined, async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
        return i;
      }),
    );
    await tick();
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(3);
    for (const gate of gates) {
      gate.resolve();
      await tick();
    }
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it("grants slots in FIFO order", async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire();
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) =>
      sem.acquire().then((r) => {
        order.push(n);
        r();
      }),
    );
    release();
    await Promise.all(waits);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the slot when the task throws", async () => {
    const sem = new AsyncSemaphore(1);
    await expect(
      sem.run(undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.active).toBe(0);
    await expect(sem.run(undefined, async () => "ok")).resolves.toBe("ok");
  });

  it("ignores a second release", async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.active).toBe(0);
    await sem.acquire();
    expect(sem.active).toBe(1);
  });

  it("drops an aborted waiter without taking a slot", async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire();
    const ac = new AbortController();
    let ran = false;
    const waiting = sem.run(ac.signal, async () => {
      ran = true;
    });
    const next = sem.run(undefined, async () => "next");
    await tick();
    expect(sem.waiting).toBe(2);
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(sem.waiting).toBe(1);
    release();
    await expect(next).resolves.toBe("next");
    expect(ran).toBe(false);
    expect(sem.active).toBe(0);
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const sem = new AsyncSemaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sem.active).toBe(0);
  });

  it("does not let an abort after the grant disturb the count", async () => {
    const sem = new AsyncSemaphore(1);
    const ac = new AbortController();
    const release = await sem.acquire(ac.signal);
    ac.abort();
    expect(sem.active).toBe(1);
    release();
    expect(sem.active).toBe(0);
  });
});

describe("mapWithConcurrency", () => {
  it("bounds in-flight calls and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("stops starting items after a failure and rethrows it", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
        started.push(n);
        if (n === 1) throw new Error("bad");
        return n;
      }),
    ).rejects.toThrow("bad");
    expect(started).toEqual([0, 1]);
  });

  it("stops starting items once the signal aborts", async () => {
    const ac = new AbortController();
    const started: number[] = [];
    await expect(
      mapWithConcurrency(
        [0, 1, 2, 3],
        1,
        async (n) => {
          started.push(n);
          if (n === 1) ac.abort();
          return n;
        },
        ac.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toEqual([0, 1]);
  });
});

describe("heavy read-verb gate", () => {
  it("classifies the scan verbs as heavy and point lookups as light", () => {
    for (const verb of [
      "graph.audit",
      "graph.dead",
      "graph.risk",
      "graph.subgraph",
      "graph.trace",
      "rows.project",
      "vector.similar",
      "vector.surprises",
    ]) {
      expect(isHeavyReadVerb(verb)).toBe(true);
    }
    for (const verb of ["graph.resolve", "rows.locate", "search", 42]) {
      expect(isHeavyReadVerb(verb)).toBe(false);
    }
  });

  it("reads GMAX_HEAVY_READ_CONCURRENCY and ignores junk", () => {
    expect(resolveHeavyReadConcurrency(undefined)).toBe(
      DEFAULT_HEAVY_READ_CONCURRENCY,
    );
    expect(resolveHeavyReadConcurrency("4")).toBe(4);
    for (const junk of ["0", "-1", "1.5", "abc", ""]) {
      expect(resolveHeavyReadConcurrency(junk)).toBe(
        DEFAULT_HEAVY_READ_CONCURRENCY,
      );
    }
  });

  it("queues heavy verbs on the gate and lets light verbs through", async () => {
    const gate = new AsyncSemaphore(1);
    const hold = deferred();
    const first = runReadVerb(
      "graph.audit",
      new AbortController().signal,
      () => hold.promise,
      gate,
    );
    let heavyRan = false;
    const ac = new AbortController();
    const queued = runReadVerb(
      "vector.surprises",
      ac.signal,
      async () => {
        heavyRan = true;
      },
      gate,
    );
    const light = await runReadVerb(
      "graph.resolve",
      new AbortController().signal,
      async () => "light",
      gate,
    );
    expect(light).toBe("light");
    await tick();
    expect(heavyRan).toBe(false);
    expect(gate.waiting).toBe(1);

    // A client that disconnects while queued never reaches the store.
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    hold.resolve();
    await first;
    expect(heavyRan).toBe(false);
    expect(gate.active).toBe(0);
  });
});

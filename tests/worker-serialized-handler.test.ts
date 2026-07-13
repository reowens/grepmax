import { describe, expect, it } from "vitest";
import { createSerializedHandler } from "../src/lib/workers/serialized-handler";

describe("worker message serialization", () => {
  it("does not overlap task handlers", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const handler = createSerializedHandler(async (id: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });

    const first = handler(1);
    const second = handler(2);
    await Promise.resolve();
    expect(started).toEqual([1]);

    releases.shift()?.();
    await first;
    await Promise.resolve();
    expect(started).toEqual([1, 2]);

    releases.shift()?.();
    await second;
    expect(maxActive).toBe(1);
  });

  it("continues the chain after a handler failure", async () => {
    const calls: number[] = [];
    const handler = createSerializedHandler(async (id: number) => {
      calls.push(id);
      if (id === 1) throw new Error("failed");
    });

    await expect(handler(1)).rejects.toThrow("failed");
    await expect(handler(2)).resolves.toBeUndefined();
    expect(calls).toEqual([1, 2]);
  });
});

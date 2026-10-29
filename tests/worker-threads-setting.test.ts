import { describe, expect, it } from "vitest";
import {
  defaultWorkerThreads,
  parseWorkerThreads,
  resolveWorkerThreads,
} from "../src/config";

describe("worker threads setting", () => {
  it("prefers the env var over the stored value", () => {
    expect(
      resolveWorkerThreads({ env: "3", configValue: 2, cores: 8 }),
    ).toEqual({ value: 3, source: "env" });
  });

  it("uses the stored value when the env var is unset or not a number", () => {
    expect(resolveWorkerThreads({ configValue: 2, cores: 8 })).toEqual({
      value: 2,
      source: "config",
    });
    expect(
      resolveWorkerThreads({ env: "lots", configValue: 1, cores: 8 }),
    ).toEqual({ value: 1, source: "config" });
  });

  it("falls back to the computed default", () => {
    expect(resolveWorkerThreads({ cores: 14 })).toEqual({
      value: 4,
      source: "default",
    });
    expect(resolveWorkerThreads({ cores: 1 })).toEqual({
      value: 1,
      source: "default",
    });
  });

  it("ignores a stored value outside 1..cores", () => {
    expect(resolveWorkerThreads({ configValue: 0, cores: 8 }).source).toBe(
      "default",
    );
    expect(resolveWorkerThreads({ configValue: 9, cores: 8 }).source).toBe(
      "default",
    );
    expect(resolveWorkerThreads({ configValue: 2.5, cores: 8 }).source).toBe(
      "default",
    );
  });

  it("sizes defaults from the effective CPU quota instead of the host core count", () => {
    expect(resolveWorkerThreads({ cores: 16, cpuBudget: 2 })).toEqual({
      value: 2,
      source: "default",
    });
    expect(resolveWorkerThreads({ cores: 16, cpuBudget: 1 })).toEqual({
      value: 1,
      source: "default",
    });
  });

  it("preserves explicit worker overrides when the default CPU budget is smaller", () => {
    expect(
      resolveWorkerThreads({ cores: 16, cpuBudget: 2, configValue: 4 }),
    ).toEqual({ value: 4, source: "config" });
    expect(resolveWorkerThreads({ cores: 16, cpuBudget: 2, env: "3" })).toEqual(
      { value: 3, source: "env" },
    );
    expect(
      resolveWorkerThreads({ cores: 2, cpuBudget: 1, configValue: 2, env: "6" }),
    ).toEqual({ value: 6, source: "env" });
    expect(
      resolveWorkerThreads({ cores: 2, cpuBudget: 1, configValue: 3 }),
    ).toEqual({ value: 1, source: "default" });
  });

  it("bounds injected default budgets by whole available host cores", () => {
    expect(resolveWorkerThreads({ cores: 16, cpuBudget: 2.9 }).value).toBe(2);
    expect(resolveWorkerThreads({ cores: 1, cpuBudget: 8 }).value).toBe(1);
    expect(resolveWorkerThreads({ cores: 16, cpuBudget: 0 }).value).toBe(1);
    expect(
      resolveWorkerThreads({ cores: 6, cpuBudget: Number.NaN }).value,
    ).toBe(3);
  });

  it("parses typed values strictly", () => {
    expect(parseWorkerThreads("2", 8)).toBe(2);
    expect(parseWorkerThreads(" 8 ", 8)).toBe(8);
    expect(parseWorkerThreads("9", 8)).toBeNull();
    expect(parseWorkerThreads("0", 8)).toBeNull();
    expect(parseWorkerThreads("-1", 8)).toBeNull();
    expect(parseWorkerThreads("2x", 8)).toBeNull();
    expect(parseWorkerThreads("1.5", 8)).toBeNull();
  });

  it("keeps the default between 2 and 4 where the cores exist", () => {
    expect(defaultWorkerThreads(2)).toBe(2);
    expect(defaultWorkerThreads(6)).toBe(3);
    expect(defaultWorkerThreads(32)).toBe(4);
  });
});

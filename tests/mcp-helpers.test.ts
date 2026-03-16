import { describe, expect, it } from "vitest";
import { err, ok, toStringArray } from "../src/commands/mcp";

describe("toStringArray", () => {
  it("returns strings from a string array", () => {
    expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("filters out non-string values", () => {
    expect(toStringArray(["a", 1, null, "b", undefined])).toEqual(["a", "b"]);
  });

  it("returns empty array for non-array input", () => {
    expect(toStringArray("not an array")).toEqual([]);
    expect(toStringArray(123)).toEqual([]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });

  it("handles objects with toArray method", () => {
    const obj = { toArray: () => ["x", "y"] };
    expect(toStringArray(obj)).toEqual(["x", "y"]);
  });

  it("handles toArray returning non-array", () => {
    const obj = { toArray: () => "not array" };
    expect(toStringArray(obj)).toEqual([]);
  });

  it("handles toArray that throws", () => {
    const obj = {
      toArray: () => {
        throw new Error("boom");
      },
    };
    expect(toStringArray(obj)).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(toStringArray([])).toEqual([]);
  });
});

describe("ok", () => {
  it("wraps text in MCP content format", () => {
    const result = ok("success");
    expect(result).toEqual({
      content: [{ type: "text", text: "success" }],
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("err", () => {
  it("wraps text in MCP error format", () => {
    const result = err("failure");
    expect(result).toEqual({
      content: [{ type: "text", text: "failure" }],
      isError: true,
    });
  });
});

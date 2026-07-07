import { describe, expect, it } from "vitest";
import { stampLines } from "../src/lib/utils/logger";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} /;

describe("stampLines", () => {
  it("stamps each complete line", () => {
    const state = { atLineStart: true };
    const out = stampLines("[daemon] one\n[pool] two\n", state);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(STAMP);
    expect(lines[0]).toContain("[daemon] one");
    expect(lines[1]).toContain("[pool] two");
    expect(state.atLineStart).toBe(true);
  });

  it("stamps a line split across chunks exactly once", () => {
    const state = { atLineStart: true };
    const first = stampLines("[daemon] partial", state);
    expect(first).toMatch(STAMP);
    expect(state.atLineStart).toBe(false);
    const second = stampLines(" continued\n", state);
    expect(second).toBe(" continued\n");
    expect(state.atLineStart).toBe(true);
  });

  it("leaves blank lines unstamped", () => {
    const state = { atLineStart: true };
    const out = stampLines("\n[daemon] after blank\n", state);
    expect(out.startsWith("\n")).toBe(true);
    expect(out.slice(1)).toMatch(STAMP);
  });

  it("handles a chunk with a trailing unterminated line", () => {
    const state = { atLineStart: true };
    const out = stampLines("a\nb", state);
    const [lineA, lineB] = out.split("\n");
    expect(lineA).toMatch(STAMP);
    expect(lineB).toMatch(STAMP);
    expect(state.atLineStart).toBe(false);
  });
});

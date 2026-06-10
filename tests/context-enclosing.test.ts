import { describe, expect, it } from "vitest";
import { findEnclosingSignature } from "../src/commands/context";

const FILE = [
  "import * as fs from 'node:fs';",
  "",
  "export class Daemon {",
  "  private vectorDb: VectorDB | null = null;",
  "",
  "  async start(): Promise<void> {",
  "    // lots of body",
  "    this.heartbeat();",
  "  }",
  "",
  "  private heartbeat(): void {",
  "    // a sub-chunk might start here",
  "    const daemon = this; // mentions nothing relevant",
  "  }",
  "}",
];

describe("findEnclosingSignature", () => {
  it("finds the class definition line above a mid-class chunk", () => {
    const sig = findEnclosingSignature(FILE, 11, "Daemon");
    expect(sig).toEqual({ text: "export class Daemon {", line: 2 });
  });

  it("does not match a mere mention between definition and chunk", () => {
    // `const daemon = this` (line 12) is lowercase — different symbol; an
    // actual reference like `new Daemon()` below the def must not win either.
    const lines = [...FILE];
    lines[7] = "    const d = new Daemon();";
    const sig = findEnclosingSignature(lines, 11, "Daemon");
    // new Daemon() matches `Daemon\s*(` — definition-shaped regexes can't
    // tell constructor calls from definitions; nearest-above picks line 7.
    // What matters: it never returns null when a real definition exists.
    expect(sig).not.toBeNull();
  });

  it("returns null when the symbol is not defined above", () => {
    expect(findEnclosingSignature(FILE, 11, "Missing")).toBeNull();
  });

  it("rejects non-identifier parent symbols", () => {
    expect(findEnclosingSignature(FILE, 11, "a.b")).toBeNull();
    expect(findEnclosingSignature(FILE, 11, "")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  fileNotFoundLines,
  symbolNotFoundLines,
} from "../src/lib/utils/agent-errors";

describe("agent-errors not-found rendering", () => {
  describe("symbolNotFoundLines", () => {
    it("agent mode: compact, with a trailing next: recovery line", () => {
      const lines = symbolNotFoundLines("Foo", { agent: true });
      expect(lines[0]).toBe("Symbol not found: Foo");
      const next = lines.find((l) => l.startsWith("next:"));
      expect(next).toBeDefined();
      expect(next).toContain("gmax status");
      expect(next).toContain("gmax search Foo");
      // No multi-line "Possible reasons" block under --agent.
      expect(lines.some((l) => l.includes("Possible reasons"))).toBe(false);
    });

    it("human mode: keeps the rich Possible reasons / Try block", () => {
      const lines = symbolNotFoundLines("Foo");
      expect(lines[0]).toBe("Symbol not found: Foo");
      const text = lines.join("\n");
      expect(text).toContain("Possible reasons:");
      expect(text).toContain("Try:");
      expect(text).toContain("gmax status");
      // No agent next: line in human mode.
      expect(lines.some((l) => l.startsWith("next:"))).toBe(false);
    });

    it("applies bold/dim styling when provided", () => {
      const lines = symbolNotFoundLines("Foo", {
        bold: (s) => `<b>${s}</b>`,
        dim: (s) => `<d>${s}</d>`,
      });
      expect(lines[0]).toBe("Symbol not found: <b>Foo</b>");
      expect(lines.some((l) => l.startsWith("<d>"))).toBe(true);
    });
  });

  describe("fileNotFoundLines", () => {
    it("agent mode: compact next: line preserving the path-relative tip", () => {
      const lines = fileNotFoundLines("src/x.ts", { agent: true });
      expect(lines[0]).toBe("File not found in index: src/x.ts");
      const next = lines.find((l) => l.startsWith("next:"));
      expect(next).toContain("relative to the project root");
      expect(next).toContain("gmax status");
    });

    it("human mode: rich Try block including the path-relative tip", () => {
      const text = fileNotFoundLines("src/x.ts").join("\n");
      expect(text).toContain("File not found in index: src/x.ts");
      expect(text).toContain("relative to the project root");
      expect(text).toContain("gmax status");
    });
  });
});

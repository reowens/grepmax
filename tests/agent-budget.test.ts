import { expect, it } from "vitest";
import { formatAgent, formatHuman } from "../src/commands/audit";
import { boundedAgentText } from "../src/lib/output/agent-budget";

it("bounds long bodies and long single lines with explicit loss counts", () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  expect(boundedAgentText(body, 6000, 120)).toContain("omitted 80 lines");
  expect(boundedAgentText("x".repeat(20000), 6000, 120)).toContain(
    "14000 characters",
  );
  expect(boundedAgentText("short\nbody")).toBe("short\nbody");
});
it("compact audit cycles retain total size and report files omitted", () => {
  const output = formatAgent({
    scannedChunks: 200,
    scannedFiles: 200,
    godNodes: [],
    hubFiles: [],
    deadCandidates: [],
    deadTotal: 0,
    fileCycles: [
      {
        files: Array.from({ length: 200 }, (_, i) => `source${i}.ts`),
        edgeCount: 200,
      },
    ],
  });
  const row = output.split("\n").find((line) => line.startsWith("cycle"))!;
  expect(row.length).toBeLessThan(1200);
  expect(row).toContain("\t200\t200\tomitted_files=192");
});

it("does not split names when cycle filenames reach the character budget", () => {
  const files = ["first.ts", "x".repeat(1001), "third.ts"];
  const row = formatAgent({
    scannedChunks: 3,
    scannedFiles: 3,
    godNodes: [],
    hubFiles: [],
    deadCandidates: [],
    deadTotal: 0,
    fileCycles: [{ files, edgeCount: 3 }],
  })
    .split("\n")
    .find((line) => line.startsWith("cycle"))!;
  expect(row).toBe("cycle\tfirst.ts\t3\t3\tomitted_files=2");
});
it("reports uncertainty in human audit output", () => {
  expect(
    formatHuman({
      scannedChunks: 3,
      scannedFiles: 3,
      ambiguousSymbols: 2,
      godNodes: [],
      hubFiles: [],
      deadCandidates: [],
      deadTotal: 0,
      fileCycles: [],
    }),
  ).toContain("Unresolved symbol names omitted: 2");
});
it("preserves Unicode at the excerpt boundary and counts completely hidden lines", () => {
  const text = boundedAgentText("ab😀c", 3, 120);
  expect(text).toBe("ab\n… omitted 0 lines, 3 characters");
  expect(Buffer.from(text).toString("utf8")).not.toContain("�");
  expect(boundedAgentText("one\ntwo", 0)).toContain(
    "omitted 2 lines, 7 characters",
  );
});

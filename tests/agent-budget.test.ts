import { expect, it } from "vitest";
import { boundedAgentText } from "../src/lib/output/agent-budget";
import { formatAgent } from "../src/commands/audit";
it("bounds long bodies and long single lines with explicit loss counts", () => {
  const body=Array.from({length:200},(_,i)=>`line ${i}`).join("\n");
  expect(boundedAgentText(body,6000,120)).toContain("omitted 80 lines");
  expect(boundedAgentText("x".repeat(20000),6000,120)).toContain("14000 characters");
  expect(boundedAgentText("short\nbody")).toBe("short\nbody");
});
it("compact audit cycles retain total size and report files omitted", () => {
  const output=formatAgent({scannedChunks:200,scannedFiles:200,godNodes:[],hubFiles:[],deadCandidates:[],deadTotal:0,fileCycles:[{files:Array.from({length:200},(_,i)=>`source${i}.ts`),edgeCount:200}]});
  const row=output.split("\n").find(line=>line.startsWith("cycle"))!;
  expect(row.length).toBeLessThan(1200);
  expect(row).toContain("\t200\t200\tomitted_files=192");
});

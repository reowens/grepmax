import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedMaintenanceReceiptState } from "../src/lib/store/bounded-maintenance";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), "gmax-receipt-advisory-"),
  );
  roots.push(store);
  const table = path.join(store, "chunks.lance");
  fs.mkdirSync(table);
  return { store, file: path.join(table, "_gmax-bounded-receipt.json") };
}

function finalized() {
  return {
    protocolVersion: 2,
    phase: "finalized",
    receiptId: "attempt-1",
    planId: "a".repeat(64),
    beforeVersion: 7,
    afterVersion: 8,
    totalWriteBudgetBytes: 512 * 1024 ** 2,
    journal: "_gmax-maintenance-attempt-1.journal",
    ownedWrites: "_gmax-owned-attempt-1.jsonl",
    beforeFingerprint: "b".repeat(64),
    acceptedFingerprint: "c".repeat(64),
    sourceRowsDigest: "d".repeat(64),
    sourceBytes: 1024,
    rowsVerified: 12,
    aborted: false,
    abortProven: false,
    retiredMetadata: [],
    selectedFragmentIds: [1],
    readerTag: "gmax-before-1",
    afterTag: "gmax-after-1",
    originalTags: { user: 6 },
  };
}

describe("bounded native receipt startup advisory", () => {
  it("does not route a missing or complete historical finalized receipt to recovery", () => {
    const f = fixture();
    expect(boundedMaintenanceReceiptState(f.store)).toBe("missing");
    fs.writeFileSync(f.file, JSON.stringify(finalized()));
    expect(boundedMaintenanceReceiptState(f.store)).toBe("finalized");
    fs.writeFileSync(
      f.file,
      JSON.stringify({ ...finalized(), aborted: true, abortProven: true }),
    );
    expect(boundedMaintenanceReceiptState(f.store)).toBe("finalized");
  });

  it("accepts the actual finalized abort before selected rows were decoded", () => {
    const f = fixture();
    const receipt = {
      ...finalized(),
      aborted: true,
      abortProven: true,
      rowsVerified: 0,
      sourceRowsDigest: "",
    };
    fs.writeFileSync(f.file, JSON.stringify(receipt));
    expect(boundedMaintenanceReceiptState(f.store)).toBe("finalized");
    for (const change of [
      { aborted: false },
      { abortProven: false },
      { rowsVerified: 1 },
    ]) {
      fs.writeFileSync(f.file, JSON.stringify({ ...receipt, ...change }));
      expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
    }
  });

  it.each(["copying", "copied", "finalizing", "abort-proven", "aborted"])(
    "routes %s to native proof rather than treating it as completion",
    (phase) => {
      const f = fixture();
      fs.writeFileSync(f.file, JSON.stringify({ ...finalized(), phase }));
      expect(boundedMaintenanceReceiptState(f.store)).toBe("pending");
    },
  );

  it.each([
    { protocolVersion: 1 },
    { afterVersion: null },
    { acceptedFingerprint: null },
    { journal: "../other" },
    { totalWriteBudgetBytes: 0 },
    { aborted: true, abortProven: false },
    { retiredMetadata: ["pending.journal"] },
  ])(
    "routes incomplete finalized state to the native verifier %j",
    (change) => {
      const f = fixture();
      fs.writeFileSync(f.file, JSON.stringify({ ...finalized(), ...change }));
      expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
    },
  );

  it("rejects malformed, oversized and nonregular receipt files without following a symlink", () => {
    const f = fixture();
    fs.writeFileSync(f.file, "{");
    expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
    fs.writeFileSync(f.file, Buffer.alloc(64 * 1024 + 1));
    expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
    fs.unlinkSync(f.file);
    const target = path.join(f.store, "outside-receipt.json");
    fs.writeFileSync(target, JSON.stringify(finalized()));
    fs.symlinkSync(target, f.file);
    expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
    expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(finalized()));
    fs.unlinkSync(f.file);
    fs.mkdirSync(f.file);
    expect(boundedMaintenanceReceiptState(f.store)).toBe("unknown");
  });
});

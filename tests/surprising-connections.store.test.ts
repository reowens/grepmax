import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSurprisingConnections } from "../src/lib/analysis/surprising-connections";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

// Runs the analysis against a real LanceDB table, because the scan now leans
// on store-side SQL (regexp_replace/char_length/octet_length) to decide the
// weak-code test without reading `content`, and a fake table cannot check that
// those bounds agree with the JS `content.trim().length >= 80` they replace.

const PROJECT = "/repo/app";
const DIM = 8;

function record(over: Partial<VectorRecord> & { id: string }): VectorRecord {
  return {
    hash: "h",
    content: "",
    display_text: "",
    start_line: 0,
    end_line: 20,
    chunk_index: 0,
    is_anchor: false,
    context_prev: "",
    context_next: "",
    chunk_type: "",
    complexity: 0,
    is_exported: false,
    vector: Array(DIM).fill(0),
    colbert: Buffer.alloc(0),
    colbert_scale: 1,
    pooled_colbert_48d: Array(48).fill(0),
    doc_token_ids: [],
    defined_symbols: [],
    referenced_symbols: [],
    type_referenced_symbols: [],
    member_referenced_symbols: [],
    imports: [],
    exports: [],
    role: "IMPLEMENTATION",
    parent_symbol: "",
    file_skeleton: "",
    summary: "",
    path: "",
    ...over,
  } as VectorRecord;
}

// Each case lands in its own top-level directory so no pair is dropped as a
// same-bucket neighbour, and every vector is close to every other.
const CONTENTS: Record<string, string> = {
  plain: "x".repeat(100), // passes on the lower bound
  accented: "é".repeat(85), // passes on the lower bound (85 code points)
  padded: `  ${"é".repeat(70)}\n`, // undecided by bounds, trims to 70: fails
  nbsp: `${" ".repeat(10)}${"a".repeat(75)}`, // undecided, JS trims NBSP: fails
  short: "short", // fails on the upper bound
  tabbed: `\t\t${"b".repeat(78)}  \n`, // fails on the upper bound (78)
  emoji: "😀".repeat(40), // undecided, 80 UTF-16 units: passes
  feff: `﻿${"c".repeat(79)}`, // undecided, JS trims U+FEFF to 79: fails
};

function expectedCodeIds(): string[] {
  return Object.entries(CONTENTS)
    .filter(([, content]) => content.trim().length >= 80)
    .map(([id]) => id)
    .sort();
}

let tmp: string;
let db: VectorDB;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-surprises-store-"));
  db = new VectorDB(path.join(tmp, "lancedb"), DIM);
  await db.insertBatch(
    Object.entries(CONTENTS).map(([id, content], i) =>
      record({
        id,
        path: `${PROJECT}/${id}/mod.ts`,
        content,
        defined_symbols: [`symbol${i}`],
        vector: [1, i * 0.01, 0, 0, 0, 0, 0, 0],
      }),
    ),
  );
});

afterAll(async () => {
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("analyzeSurprisingConnections on a real store", () => {
  it("matches the JS weak-code test and samples only passing anchors", async () => {
    const table = await db.ensureTable();
    const result = await analyzeSurprisingConnections(table, PROJECT, {
      sample: 100,
      neighbors: 20,
    });
    const expected = expectedCodeIds();
    expect(expected).toEqual(["accented", "emoji", "plain"]);
    expect(result.summary.rows).toBe(Object.keys(CONTENTS).length);
    expect(result.summary.codeRows).toBe(expected.length);
    expect(result.summary.sampledAnchors).toBe(expected.length);

    expect(result.pairs.length).toBeGreaterThan(0);
    const sources = new Set(result.pairs.map((p) => p.source.id));
    for (const id of sources) expect(expected).toContain(id);
    for (const pair of result.pairs) {
      expect(expected).toContain(pair.target.id);
      // Anchors carry their hydrated content into scoring...
      expect(pair.source.content).toBe(CONTENTS[pair.source.id]);
      // ...but no row in the answer carries a vector.
      expect(pair.source.vector).toBeUndefined();
      expect(pair.target.vector).toBeUndefined();
    }
  });

  it("caps anchors at the sample size", async () => {
    const table = await db.ensureTable();
    const result = await analyzeSurprisingConnections(table, PROJECT, {
      sample: 2,
      neighbors: 20,
    });
    expect(result.summary.codeRows).toBe(3);
    expect(result.summary.sampledAnchors).toBe(2);
  });
});

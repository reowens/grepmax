import { describe, expect, it, vi } from "vitest";
import {
  chunkHistoryRecords,
  isHistoryRecordEligible,
  rankHistoryChunks,
  validateHistoryRecord,
} from "../src/lib/history/adapter";
import type { HistoryRecord } from "../src/lib/history/contract";

const record = (
  turnKey: string,
  fields: Partial<HistoryRecord> = {},
): HistoryRecord => ({
  schemaVersion: 1,
  sessionKey: "session-a",
  turnKey,
  provider: "codex",
  machine: "P3",
  speaker: "him",
  at: 100,
  text: "Original question?",
  sourceLocator: `archive:fixture#${turnKey}`,
  sourceRevision: "rev-1",
  truncated: false,
  omissions: [],
  project: "gmax",
  ...fields,
});

// These synthetic scores exercise contract wiring, never model quality.
describe("history adapter v1", () => {
  it("keeps an exchange's exact speakers, whitespace, times and evidence", () => {
    const records = [
      record("u", { text: "  do it?\n", at: null }),
      record("a", { speaker: "assistant", text: "I suggest it.\n", at: 99 }),
      record("t", { speaker: "tool", text: "failure", at: 98 }),
    ];
    const [chunk] = chunkHistoryRecords(records);
    expect(
      chunk.segments.map((s) => [
        s.text,
        s.speaker,
        s.at,
        s.sourceLocator,
        s.sourceRevision,
      ]),
    ).toEqual(
      records.map((s) => [
        s.text,
        s.speaker,
        s.at,
        s.sourceLocator,
        s.sourceRevision,
      ]),
    );
    expect(chunk.embeddingText).toBe(
      "him:   do it?\n\nassistant: I suggest it.\n\ntool: failure",
    );
    expect(chunk.segments.map((s) => s.turnKey)).toEqual(["u", "a", "t"]);
  });

  it("starts exchanges at user turns and isolates parent and subagent streams", () => {
    const chunks = chunkHistoryRecords([
      record("u1"),
      record("child-u", {
        sessionKey: "child",
        agentKey: "worker",
        parentSessionKey: "session-a",
      }),
      record("a1", { speaker: "assistant" }),
      record("u2"),
      record("child-a", {
        sessionKey: "child",
        speaker: "assistant",
        agentKey: "worker",
        parentSessionKey: "session-a",
      }),
    ]);
    expect(chunks.map((c) => c.segments.map((s) => s.turnKey))).toEqual([
      ["u1", "a1"],
      ["u2"],
      ["child-u", "child-a"],
    ]);
    expect(
      chunks[2].segments.every(
        (s) => s.agentKey === "worker" && s.parentSessionKey === "session-a",
      ),
    ).toBe(true);
    expect(new Set(chunks.map((c) => c.exchangeKey)).size).toBe(3);
  });

  it("retains orphan replies and empty turns rather than dropping evidence", () => {
    const chunks = chunkHistoryRecords([
      record("a", { speaker: "assistant", text: "" }),
      record("u"),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].segments[0]).toMatchObject({
      text: "",
      speaker: "assistant",
      textStart: 0,
      textEnd: 0,
    });
    expect(chunkHistoryRecords([])).toEqual([]);
  });

  it("reconstructs a long turn and its tail from bounded continuation chunks", () => {
    const prompt = record("u", { text: "Prompt" });
    const reply = record("a", {
      speaker: "assistant",
      text: "🌱exact\n".repeat(1500) + "TAIL",
      at: null,
      sourceRevision: "revision-long",
      agentKey: "main",
      parentSessionKey: "parent",
      truncated: true,
      omissions: ["tool results unavailable"],
      segmentIndex: 4,
      continuationOf: "native-prior",
    });
    // Match stream metadata so the reply remains with its prompt.
    const chunks = chunkHistoryRecords(
      [{ ...prompt, agentKey: "main", parentSessionKey: "parent" }, reply],
      { maxTextChars: 31, maxSegments: 2 },
    );
    const segments = chunks
      .flatMap((c) => c.segments)
      .filter((s) => s.turnKey === "a");
    expect(segments.map((s) => s.text).join("")).toBe(reply.text);
    expect(segments.at(-1)?.text.endsWith("TAIL")).toBe(true);
    expect(chunks[0].segments.map((s) => s.speaker)).toEqual([
      "him",
      "assistant",
    ]);
    expect(new Set(chunks.map((c) => c.exchangeKey)).size).toBe(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(
        chunks[i].segments.reduce((n, s) => n + s.text.length, 0),
      ).toBeLessThanOrEqual(31);
      expect(chunks[i].segments.length).toBeLessThanOrEqual(2);
      expect(chunks[i].previousChunkKey).toBe(
        i ? chunks[i - 1].chunkKey : undefined,
      );
    }
    segments.forEach((s, i) => {
      expect(s.text).toBe(reply.text.slice(s.textStart, s.textEnd));
      expect(s.previousSegmentKey).toBe(
        i ? segments[i - 1].segmentKey : undefined,
      );
      expect(s).toMatchObject({
        at: null,
        speaker: "assistant",
        truncated: true,
        omissions: ["tool results unavailable"],
        sourceRevision: "revision-long",
        segmentIndex: 4,
        continuationOf: "native-prior",
      });
    });
  });

  it("respects segment count bounds even for empty/tool-heavy exchanges", () => {
    const chunks = chunkHistoryRecords(
      Array.from({ length: 7 }, (_, i) =>
        record(String(i), {
          speaker: i ? "tool" : "him",
          text: "",
        }),
      ),
      { maxSegments: 2 },
    );
    expect(chunks.map((c) => c.segments.length)).toEqual([2, 2, 2, 1]);
  });

  it.each([1, 2, 3, 4, 5])(
    "reconstructs Unicode with a %i-unit bound",
    (maxTextChars) => {
      const text = "🌱a🌱\r\n\t🌱";
      const chunks = chunkHistoryRecords([record("u", { text })], {
        maxTextChars,
      });
      expect(
        chunks
          .flatMap((c) => c.segments)
          .map((s) => s.text)
          .join(""),
      ).toBe(text);
      expect(
        chunks.every(
          (c) =>
            c.segments.reduce((n, s) => n + s.text.length, 0) <= maxTextChars,
        ),
      ).toBe(true);
    },
  );

  it("keeps identities and embedding reuse stable across metadata/revision changes", () => {
    const original = record("u");
    const [before] = chunkHistoryRecords([original]);
    const [after] = chunkHistoryRecords([
      {
        ...original,
        at: 987,
        project: "renamed",
        plans: ["new-plan"],
        sourceRevision: "rev-2",
        sourceLocator: "archive:relocated#u",
        truncated: true,
        omissions: ["legacy unsupported"],
      },
    ]);
    expect(after.chunkKey).toBe(before.chunkKey);
    expect(after.exchangeKey).toBe(before.exchangeKey);
    expect(after.segments[0].segmentKey).toBe(before.segments[0].segmentKey);
    expect(after.embeddingKey).toBe(before.embeddingKey);
    expect(after.segments[0].sourceRevision).toBe("rev-2");
    const [changed] = chunkHistoryRecords([
      { ...original, text: "Different original" },
    ]);
    expect(changed.embeddingKey).not.toBe(before.embeddingKey);
  });

  it("preserves upstream continuation identity without making a new user exchange", () => {
    const chunks = chunkHistoryRecords([
      record("u", { segmentIndex: 0 }),
      record("u", { segmentIndex: 1, continuationOf: "u", text: "more" }),
      record("a", { speaker: "assistant" }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].segments.map((s) => s.segmentIndex)).toEqual([
      0,
      1,
      undefined,
    ]);
    expect(new Set(chunks[0].segments.map((s) => s.segmentKey)).size).toBe(3);
  });

  it("does not let 60 out-of-range near matches consume top-k slots or ranking calls", () => {
    const outside = Array.from({ length: 60 }, (_, i) =>
      record(`out-${i}`, { at: i, text: "near match" }),
    );
    const chunks = chunkHistoryRecords([
      ...outside,
      record("in", { at: 100, text: "eligible" }),
    ]);
    const scorer = vi.fn((segments: readonly HistoryRecord[]) =>
      segments[0].text === "near match" ? 1000 : 1,
    );
    const hits = rankHistoryChunks(
      chunks,
      { schemaVersion: 1, since: 100, until: 101, topK: 1 },
      scorer,
    );
    expect(hits.map((h) => h.chunk.segments[0].turnKey)).toEqual(["in"]);
    expect(scorer).toHaveBeenCalledTimes(1);
  });

  it("requires all predicates on the same turn and labels surrounding context", () => {
    const chunks = chunkHistoryRecords([
      record("u", { at: 100 }),
      record("a", { at: 200, speaker: "assistant", text: "suggestion" }),
    ]);
    const score = vi.fn(() => 1);
    expect(
      rankHistoryChunks(
        chunks,
        {
          schemaVersion: 1,
          since: 100,
          until: 200,
          speakers: ["assistant"],
          topK: 1,
        },
        score,
      ),
    ).toEqual([]);
    expect(score).not.toHaveBeenCalled();
    const hits = rankHistoryChunks(
      chunks,
      {
        schemaVersion: 1,
        since: 200,
        until: 201,
        speakers: ["assistant"],
        topK: 1,
      },
      score,
    );
    expect(hits[0].eligibleSegmentKeys).toEqual([
      chunks[0].segments[1].segmentKey,
    ]);
    expect(hits[0].chunk.segments.map((s) => s.speaker)).toEqual([
      "him",
      "assistant",
    ]);
    expect(score.mock.calls[0]).toEqual([[chunks[0].segments[1]]]);
  });

  it("applies exact provider/project/machine/speaker filters and half-open date bounds", () => {
    const r = record("u");
    expect(
      isHistoryRecordEligible(r, {
        since: 100,
        until: 101,
        providers: ["codex"],
        projects: ["gmax"],
        machines: ["P3"],
        speakers: ["him"],
      }),
    ).toBe(true);
    for (const filter of [
      { since: 101 },
      { until: 100 },
      { providers: ["claude"] },
      { projects: ["other"] },
      { machines: ["T7"] },
      { speakers: ["assistant"] as const },
      { providers: [] },
    ]) {
      expect(isHistoryRecordEligible(r, filter)).toBe(false);
    }
    expect(
      isHistoryRecordEligible(
        record("missing-project", { project: undefined }),
        { projects: ["gmax"] },
      ),
    ).toBe(false);
  });

  it("keeps unknown time and omissions visible but excludes unknown time from date ranges", () => {
    const r = record("unknown", {
      at: null,
      truncated: true,
      omissions: ["unsupported source content"],
    });
    expect(isHistoryRecordEligible(r, {})).toBe(true);
    expect(isHistoryRecordEligible(r, { since: 0 })).toBe(false);
    expect(isHistoryRecordEligible(r, { until: 200 })).toBe(false);
    expect(chunkHistoryRecords([r])[0].segments[0]).toMatchObject({
      at: null,
      truncated: true,
      omissions: r.omissions,
    });
  });

  it("ranks eligible chunks before top-k and breaks score ties deterministically", () => {
    const chunks = chunkHistoryRecords([
      record("u1"),
      record("u2"),
      record("u3"),
    ]);
    const score = (segments: readonly HistoryRecord[]) =>
      segments[0].turnKey === "u3" ? 5 : 1;
    const query = { schemaVersion: 1 as const, topK: 2 };
    const hits = rankHistoryChunks(chunks, query, score);
    expect(hits[0].chunk.segments[0].turnKey).toBe("u3");
    expect(rankHistoryChunks([...chunks].reverse(), query, score)).toEqual(
      hits,
    );
  });

  it("rejects legacy ambiguity, duplicate revisions and malformed bounds", () => {
    for (const fields of [
      { schemaVersion: 2 },
      { at: undefined },
      { at: NaN },
      { at: 1.5 },
      { speaker: "user" },
      { truncated: undefined },
      { omissions: undefined },
      { sourceLocator: "" },
      { segmentIndex: -1 },
    ]) {
      expect(() =>
        validateHistoryRecord(record("bad", fields as Partial<HistoryRecord>)),
      ).toThrow();
    }
    expect(() =>
      chunkHistoryRecords([
        record("same"),
        record("same", { sourceRevision: "new" }),
      ]),
    ).toThrow(/Duplicate/);
    for (const maxTextChars of [0, -1, Infinity, 1.5])
      expect(() => chunkHistoryRecords([], { maxTextChars })).toThrow();
    for (const filter of [
      { since: NaN },
      { since: 2, until: 1 },
      { since: 1, until: 1 },
    ]) {
      expect(() => isHistoryRecordEligible(record("u"), filter)).toThrow();
    }
    expect(() =>
      rankHistoryChunks([], { schemaVersion: 2, topK: 1 } as never, () => 1),
    ).toThrow();
    expect(() =>
      rankHistoryChunks([], { schemaVersion: 1, topK: 0 }, () => 1),
    ).toThrow();
    expect(() =>
      rankHistoryChunks(
        chunkHistoryRecords([record("u")]),
        { schemaVersion: 1, topK: 1 },
        () => NaN,
      ),
    ).toThrow();
  });
});

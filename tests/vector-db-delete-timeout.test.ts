import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";
import { QUERY_EXECUTION_OPTIONS } from "../src/lib/utils/query-timeout";

vi.mock("../src/lib/store/lance-sdk", () => ({}));

const nativeTimeout = () =>
  new Error(
    "Failed to get next batch from stream: lance error: Query Execution error: " +
      "Execution error: Query timeout after 15000 ms",
  );

describe.each(["deletePaths", "deletePathsExcludingIds"] as const)(
  "%s native preflight timeout",
  (method) => {
    let root: string;
    let db: VectorDB;
    let query: any;
    let table: any;
    const where =
      method === "deletePaths"
        ? "path IN ('/fixture/file''s.ts')"
        : "path IN ('/fixture/file''s.ts') AND id NOT IN ('new''id')";

    const remove = () =>
      method === "deletePaths"
        ? db.deletePaths(["/fixture/file's.ts"])
        : db.deletePathsExcludingIds(["/fixture/file's.ts"], ["new'id"]);

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-delete-timeout-"));
      db = new VectorDB(root, 4);
      // No store or host state is opened. Exercise the public deletion method
      // with a mocked write gate and native table, including handle cleanup.
      vi.spyOn(db as any, "withWriteGate").mockImplementation(async (fn: any) =>
        fn(),
      );
      query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(() => query),
        toArray: vi.fn(),
      };
      table = {
        query: vi.fn(() => query),
        delete: vi.fn(async () => {}),
        close: vi.fn(),
      };
      vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    });

    afterEach(async () => {
      await db.close();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.each([false, true])(
      "retries only the read and preserves the predicate (existing=%s)",
      async (existing) => {
        query.toArray
          .mockRejectedValueOnce(nativeTimeout())
          .mockResolvedValueOnce(existing ? [{ id: "old" }] : []);

        await remove();

        expect(table.query).toHaveBeenCalledTimes(2);
        expect(query.where.mock.calls).toEqual([[where], [where]]);
        expect(query.select.mock.calls).toEqual([[["id"]], [["id"]]]);
        expect(query.limit.mock.calls).toEqual([[1], [1]]);
        expect(query.toArray.mock.calls).toEqual([
          [QUERY_EXECUTION_OPTIONS],
          [QUERY_EXECUTION_OPTIONS],
        ]);
        expect(table.delete).toHaveBeenCalledTimes(existing ? 1 : 0);
        if (existing) expect(table.delete).toHaveBeenCalledWith(where);
        expect((db as any).writeEpoch).toBe(existing ? 1 : 0);
        expect(table.close).toHaveBeenCalledOnce();
      },
    );

    it("propagates the second timeout without deleting or claiming a write", async () => {
      const failure = nativeTimeout();
      query.toArray.mockRejectedValue(failure);

      await expect(remove()).rejects.toBe(failure);

      expect(query.toArray).toHaveBeenCalledTimes(2);
      expect(table.delete).not.toHaveBeenCalled();
      expect((db as any).writeEpoch).toBe(0);
      expect(table.close).toHaveBeenCalledOnce();
    });

    it.each([
      new Error("I/O failure"),
      new Error("LanceDB query timed out after 15000ms (JS backstop)"),
    ])("does not retry other failures: %s", async (failure) => {
      query.toArray.mockRejectedValue(failure);

      await expect(remove()).rejects.toBe(failure);

      expect(query.toArray).toHaveBeenCalledOnce();
      expect(table.delete).not.toHaveBeenCalled();
      expect(table.close).toHaveBeenCalledOnce();
    });

    it("never retries a failed mutation, even if it reports a native timeout", async () => {
      const failure = nativeTimeout();
      query.toArray.mockResolvedValue([{ id: "old" }]);
      table.delete.mockRejectedValue(failure);

      await expect(remove()).rejects.toBe(failure);

      expect(query.toArray).toHaveBeenCalledOnce();
      expect(table.delete).toHaveBeenCalledOnce();
      expect((db as any).writeEpoch).toBe(0);
      expect(table.close).toHaveBeenCalledOnce();
    });
  },
);

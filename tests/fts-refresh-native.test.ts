import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readFtsRefreshState,
  runFtsRefresh as runNativeFtsRefresh,
} from "../src/lib/store/fts-refresh";
import {
  type Connection,
  connect,
  Index,
  Session,
  type Table,
} from "../src/lib/store/lance-sdk";
import { fullTableMaintenanceDisabled } from "../src/lib/store/maintenance-policy";
import { StoreLease } from "../src/lib/store/store-lease";

const python = process.env.GMAX_FTS_TEST_PYTHON;
describe.skipIf(!python || process.platform !== "linux")(
  "native FTS delta ownership and reopening",
  () => {
    let root: string, store: string, tablePath: string;
    let connection: Connection | undefined,
      table: Table | undefined,
      lease: StoreLease | undefined;
    let active: Array<{ abort: () => void; closed: Promise<unknown> }>;
    function runFtsRefresh(...args: Parameters<typeof runNativeFtsRefresh>) {
      const controller = new AbortController();
      const signal = args[3].signal
        ? AbortSignal.any([args[3].signal, controller.signal])
        : controller.signal;
      const pending = runNativeFtsRefresh(args[0], args[1], args[2], {
        ...args[3],
        signal,
      });
      active.push({
        abort: () => controller.abort(),
        closed: pending.catch(() => {}),
      });
      return pending;
    }
    const script = path.resolve(__dirname, "../lance-maintenance/prune.py");
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fts-native-"));
      active = [];
      store = path.join(root, "store");
      tablePath = path.join(store, "chunks.lance");
    });
    afterEach(async () => {
      for (const child of active) child.abort();
      await Promise.all(active.map((child) => child.closed));
      table?.close();
      table = undefined;
      await connection?.close();
      connection = undefined;
      await lease?.release();
      lease = undefined;
      fs.rmSync(root, { recursive: true, force: true });
    });
    async function open() {
      connection = await connect(store, {
        session: new Session(BigInt(8 * 1024 ** 2), BigInt(8 * 1024 ** 2)),
      });
      table = await connection.openTable("chunks");
      return table;
    }
    async function fixture(
      appended: number,
      long = false,
      deleted = false,
      ftsOptions?: Parameters<typeof Index.fts>[0],
    ) {
      fs.mkdirSync(store, { recursive: true });
      connection = await connect(store, {
        session: new Session(BigInt(8 * 1024 ** 2), BigInt(8 * 1024 ** 2)),
      });
      const row = (i: number) => ({
        id: `id-${i}`,
        path: `/fixture/${i}.ts`,
        content: `needle${i} sharedtoken worker cache metadata running the ${long ? "alpha beta gamma delta epsilon ".repeat(16) : ""}`,
        vector: [1, i % 3, 0, 0],
      });
      table = await connection.createTable(
        "chunks",
        Array.from({ length: 128 }, (_, i) => row(i)),
      );
      await table.createIndex("content", {
        config: Index.fts({
          withPosition: true,
          stem: false,
          removeStopWords: false,
          ...ftsOptions,
        }),
      });
      await table.createIndex("path", { config: Index.btree() });
      for (let i = 0; i < appended; i += 4096)
        await table.add(
          Array.from({ length: Math.min(4096, appended - i) }, (_, n) =>
            row(128 + i + n),
          ),
        );
      if (deleted)
        await table.delete(
          [0, 2, 4, 6, 8].map((n) => `id LIKE '%${n}'`).join(" OR "),
        );
      const version = await table.version();
      const pathStats = await table.indexStats("path_idx");
      const ids = (
        await table
          .query()
          .where("id IN ('id-0', 'id-127', 'id-128')")
          .withRowId()
          .toArray()
      )
        .map((r: any) => [r.id, String(r._rowid)])
        .sort();
      table.close();
      table = undefined;
      await connection.close();
      connection = undefined;
      return { version, pathStats, ids, hashes: hashes() };
    }
    function hashes(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const file of fs.readdirSync(path.join(tablePath, "data"), {
        recursive: true,
      })) {
        const full = path.join(tablePath, "data", String(file));
        if (fs.statSync(full).isFile())
          result[String(file)] = createHash("sha256")
            .update(fs.readFileSync(full))
            .digest("hex");
      }
      return result;
    }
    async function acquire() {
      lease = await StoreLease.acquireExclusive({ storeDir: store });
      return lease;
    }
    const runtime = () => {
      const artifacts = process.env.GMAX_FTS_TEST_ARTIFACTS;
      if (!artifacts) return { python: python!, script };
      // Only this private synthetic fixture records the full exception. The
      // production helper and CLI still return fixed, redacted categories.
      const directory = path.join(root, "diagnostic-helper");
      fs.mkdirSync(directory, { recursive: true });
      const diagnostic = path.join(
        fs.realpathSync(artifacts),
        `${path.basename(root)}.txt`,
      );
      const source = fs
        .readFileSync(path.join(path.dirname(script), "fts.py"), "utf8")
        .replace(
          "    except Exception as error:\n",
          `    except Exception as error:\n        import traceback\n        trace = error.__traceback__\n        changed_files = []\n        while trace is not None:\n            frame = trace.tb_frame.f_locals\n            if 'before_files' in frame and 'after_files' in frame:\n                changed_files = [name for name, value in frame['before_files'].items() if frame['after_files'].get(name) != value][:64]\n            trace = trace.tb_next\n        Path(${JSON.stringify(diagnostic)}).write_text(traceback.format_exc() + '\\nChanged fixture files: ' + json.dumps(changed_files))\n`,
        );
      fs.writeFileSync(path.join(directory, "fts.py"), source);
      return { python: python!, script: path.join(directory, "prune.py") };
    };
    function patchedHelper(transform: (text: string) => string) {
      const directory = path.join(root, "helper");
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, "fts.py"),
        transform(
          fs.readFileSync(path.join(path.dirname(script), "fts.py"), "utf8"),
        ),
      );
      return { python: python!, script: path.join(directory, "prune.py") };
    }
    async function waitFile(file: string) {
      const until = Date.now() + 15_000;
      while (!fs.existsSync(file)) {
        if (Date.now() > until)
          throw new Error("native interruption marker not reached");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    it("catches up an 83,561-row backlog without touching base files, row IDs or another index", async () => {
      const before = await fixture(83_561);
      const result = await runFtsRefresh(
        runtime(),
        tablePath,
        await acquire(),
        {
          table: tablePath,
          run: true,
          expectedVersion: before.version,
        },
      );
      expect(result).toMatchObject({
        outcome: "completed",
        unindexedRows: 83_561,
        physicalInputRows: 83_561,
        remainingRows: 0,
        afterVersion: before.version + 1,
      });
      expect(hashes()).toEqual(before.hashes);
      expect(fullTableMaintenanceDisabled()).toBe(true);
      await lease!.release();
      lease = undefined;
      const reopened = await open();
      expect(await reopened.countRows()).toBe(83_689);
      expect(await reopened.indexStats("content_idx")).toMatchObject({
        numUnindexedRows: 0,
        numIndices: 2,
      });
      expect(await reopened.indexStats("path_idx")).toEqual(before.pathStats);
      const ids = (
        await reopened
          .query()
          .where("id IN ('id-0', 'id-127', 'id-128')")
          .withRowId()
          .toArray()
      )
        .map((r: any) => [r.id, String(r._rowid)])
        .sort();
      expect(ids).toEqual(before.ids);
      expect(
        (await reopened.query().fullTextSearch("needle83688").toArray()).map(
          (r: any) => r.id,
        ),
      ).toEqual(["id-83688"]);
      expect(readFtsRefreshState(store)?.outcome).toBe("completed");
    }, 45_000);
    it("check is native and leaves coverage, version and receipt unchanged", async () => {
      const before = await fixture(32);
      const result = await runFtsRefresh(
        runtime(),
        tablePath,
        await acquire(),
        {
          table: tablePath,
          check: true,
          expectedVersion: before.version,
        },
      );
      expect(result).toMatchObject({
        outcome: "checked",
        remainingRows: 32,
        afterVersion: before.version,
        newFileBytes: 0,
      });
      expect(readFtsRefreshState(store)).toBe(null);
      expect(hashes()).toEqual(before.hashes);
    }, 15_000);
    it("batches more than 100,000 physical rows with deletions and preserves snapshots and index settings", async () => {
      const before = await fixture(106_496, false, true);
      const pinned = await open();
      await pinned.checkout(before.version);
      const oldStats = await pinned.indexStats("content_idx");
      const expectedRows = await pinned.countRows();
      await acquire();
      const checked = await runFtsRefresh(runtime(), tablePath, lease!, {
        table: tablePath,
        check: true,
        expectedVersion: before.version,
      });
      expect(checked.unindexedRows).toBe(53_248);
      expect(checked.physicalInputRows).toBe(98_304);
      expect(checked.batchRows).toBe(49_152);
      expect(checked.remainingRows).toBe(53_248);
      expect(checked.selectedFragments).toBeLessThan(checked.pendingFragments);
      expect(readFtsRefreshState(store)).toBeNull();
      const first = await runFtsRefresh(runtime(), tablePath, lease!, {
        table: tablePath,
        run: true,
        expectedVersion: before.version,
      });
      expect(first).toMatchObject({
        batchRows: 49_152,
        physicalInputRows: 98_304,
        remainingRows: 4096,
        afterVersion: before.version + 1,
      });
      expect(readFtsRefreshState(store)?.result).toMatchObject({
        remainingRows: 4096,
      });
      expect(await pinned.version()).toBe(before.version);
      expect(await pinned.indexStats("content_idx")).toEqual(oldStats);
      const second = await runFtsRefresh(runtime(), tablePath, lease!, {
        table: tablePath,
        run: true,
        expectedVersion: first.afterVersion,
      });
      expect(second).toMatchObject({
        batchRows: 4096,
        physicalInputRows: 8192,
        remainingRows: 0,
        afterVersion: first.afterVersion + 1,
      });
      expect(hashes()).toEqual(before.hashes);
      table!.close();
      table = undefined;
      await connection!.close();
      connection = undefined;
      await lease!.release();
      lease = undefined;
      const reopened = await open();
      expect(await reopened.countRows()).toBe(expectedRows);
      expect(await reopened.indexStats("content_idx")).toMatchObject({
        numUnindexedRows: 0,
        numIndices: 3,
      });
      expect(await reopened.indexStats("path_idx")).toEqual(before.pathStats);
      const ids = (
        await reopened
          .query()
          .where("id IN ('id-0', 'id-127', 'id-128')")
          .withRowId()
          .toArray()
      )
        .map((r: any) => [r.id, String(r._rowid)])
        .sort();
      expect(ids).toEqual(before.ids);
      expect(
        (await reopened.query().fullTextSearch("needle106623").toArray()).map(
          (r: any) => r.id,
        ),
      ).toEqual(["id-106623"]);
      for (const token of ["running", "the"])
        expect(
          (
            await reopened
              .query()
              .where("id = 'id-106623'")
              .fullTextSearch(token)
              .toArray()
          ).map((r: any) => r.id),
        ).toEqual(["id-106623"]);
    }, 45_000);
    it("ends a batch before the content limit and refuses an oversized first fragment", async () => {
      const before = await fixture(8192);
      await acquire();
      // Each 4096-row fragment is below 384 KiB; both together exceed it.
      const bounded = patchedHelper((text) =>
        text.replace(
          "MAX_CONTENT_BYTES = 64 * 1024**2",
          "MAX_CONTENT_BYTES = 384 * 1024",
        ),
      );
      const result = await runFtsRefresh(bounded, tablePath, lease!, {
        table: tablePath,
        run: true,
        expectedVersion: before.version,
      });
      expect(result).toMatchObject({
        batchRows: 4096,
        physicalInputRows: 4096,
        remainingRows: 4096,
        selectedFragments: 1,
        pendingFragments: 2,
      });
      expect(result.contentBytes).toBeLessThanOrEqual(384 * 1024);
      fs.writeFileSync(
        path.join(root, "helper/fts.py"),
        fs
          .readFileSync(path.join(path.dirname(script), "fts.py"), "utf8")
          .replace("MAX_CONTENT_BYTES = 64 * 1024**2", "MAX_CONTENT_BYTES = 1"),
      );
      const receipt = fs.readFileSync(
        path.join(store, ".gmax-fts-refresh.json"),
        "utf8",
      );
      await expect(
        runFtsRefresh(bounded, tablePath, lease!, {
          table: tablePath,
          run: true,
          expectedVersion: result.afterVersion,
        }),
      ).rejects.toThrow();
      expect(
        fs.readFileSync(path.join(store, ".gmax-fts-refresh.json"), "utf8"),
      ).toBe(receipt);
      expect(hashes()).toEqual(before.hashes);
    }, 20_000);
    it.each([{ customStopWords: [] }, { customStopWords: ["sharedtoken"] }])(
      "preserves the physical custom stop-word list %j",
      async ({ customStopWords }) => {
        const before = await fixture(32, false, false, {
          removeStopWords: true,
          customStopWords,
        });
        const result = await runFtsRefresh(
          runtime(),
          tablePath,
          await acquire(),
          {
            table: tablePath,
            run: true,
            expectedVersion: before.version,
          },
        );
        expect(result).toMatchObject({ remainingRows: 0, batchRows: 32 });
        expect(hashes()).toEqual(before.hashes);
        await lease!.release();
        lease = undefined;
        const reopened = await open();
        // "the" is normally a built-in stop word, but neither explicit list
        // contains it. Search the new fragment, not the retained old segment.
        expect(
          (
            await reopened
              .query()
              .where("id = 'id-128'")
              .fullTextSearch("the")
              .toArray()
          ).map((r: any) => r.id),
        ).toEqual(["id-128"]);
      },
      15_000,
    );
    it.each(["missing-params", "missing-tokenizer"])(
      "refuses incomplete physical tokenizer metadata %s before write admission",
      async (mode) => {
        const before = await fixture(32);
        // Reproduce missing physical settings while the normalized manifest
        // description still supplies keys. Only this private fixture is edited.
        const source = `import json, os, resource, sys
from pathlib import Path
os.environ["LANCE_AUTO_MIGRATION"] = "false"
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (10, 11))
import lance
from lance.file import LanceFileReader, LanceFileWriter
root = Path(sys.argv[1])
ds = lance.dataset(str(root), index_cache_size_bytes=8*1024**2, metadata_cache_size_bytes=8*1024**2)
index = next(i for i in ds.list_indices() if i["name"] == "content_idx")
file = root / "_indices" / index["uuid"] / "metadata.lance"
reader = LanceFileReader(str(file))
metadata = dict(reader.metadata().schema.metadata)
data = reader.read_all().to_table()
if sys.argv[2] == "missing-params":
    metadata.pop(b"params")
else:
    params = json.loads(metadata[b"params"])
    params.pop("base_tokenizer")
    metadata[b"params"] = json.dumps(params).encode()
data = data.replace_schema_metadata(metadata)
temporary = file.with_name("fixture-metadata.lance")
with LanceFileWriter(str(temporary), data.schema, version="2.0") as writer:
    writer.write_batch(data)
os.replace(temporary, file)
`;
        await new Promise<void>((resolve, reject) => {
          execFile(
            python!,
            ["-I", "-c", source, tablePath, mode],
            {
              timeout: 10_000,
              killSignal: "SIGKILL",
              maxBuffer: 64 * 1024,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        const payloads = new Map<string, string>();
        for (const file of fs.readdirSync(path.join(tablePath, "_indices"), {
          recursive: true,
        })) {
          const full = path.join(tablePath, "_indices", String(file));
          if (fs.statSync(full).isFile())
            payloads.set(
              full,
              createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
            );
        }
        await expect(
          runFtsRefresh(runtime(), tablePath, await acquire(), {
            table: tablePath,
            run: true,
            expectedVersion: before.version,
          }),
        ).rejects.toThrow();
        expect(readFtsRefreshState(store)).toBeNull();
        expect(hashes()).toEqual(before.hashes);
        for (const [file, digest] of payloads)
          expect(
            createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          ).toBe(digest);
        expect(await (await open()).version()).toBe(before.version);
      },
      20_000,
    );
    it("stale versions and over-budget rows/content refuse before a write is admitted", async () => {
      const before = await fixture(32);
      await acquire();
      await expect(
        runFtsRefresh(runtime(), tablePath, lease!, {
          table: tablePath,
          run: true,
          expectedVersion: before.version - 1,
        }),
      ).rejects.toThrow();
      const rowCap = patchedHelper((text) =>
        text.replace("MAX_ROWS = 100_000", "MAX_ROWS = 3"),
      );
      await expect(
        runFtsRefresh(rowCap, tablePath, lease!, {
          table: tablePath,
          run: true,
          expectedVersion: before.version,
        }),
      ).rejects.toThrow();
      fs.writeFileSync(
        path.join(root, "helper/fts.py"),
        fs
          .readFileSync(path.join(path.dirname(script), "fts.py"), "utf8")
          .replace("MAX_CONTENT_BYTES = 64 * 1024**2", "MAX_CONTENT_BYTES = 1"),
      );
      await expect(
        runFtsRefresh(rowCap, tablePath, lease!, {
          table: tablePath,
          run: true,
          expectedVersion: before.version,
        }),
      ).rejects.toThrow();
      expect(readFtsRefreshState(store)).toBe(null);
      expect(hashes()).toEqual(before.hashes);
      expect(await (await open()).version()).toBe(before.version);
    }, 20_000);
    it.each(["during-build", "after-commit"])(
      "reopens safely after interruption %s and never silently retries",
      async (phase) => {
        const before = await fixture(
          phase === "during-build" ? 20_000 : 32,
          phase === "during-build",
        );
        const marker = path.join(root, "native-marker");
        const call =
          "        append_batch(ds, root, batch_fragments, details, format_version, verify_before_commit)";
        const interrupted = patchedHelper((text) =>
          text.replace(
            call,
            phase === "during-build"
              ? `        Path(${JSON.stringify(marker)}).write_text('building')\n${call}`
              : `${call}\n        Path(${JSON.stringify(marker)}).write_text('committed')\n        time.sleep(60)`,
          ),
        );
        const controller = new AbortController();
        const pending = runFtsRefresh(interrupted, tablePath, await acquire(), {
          table: tablePath,
          run: true,
          expectedVersion: before.version,
          signal: controller.signal,
        });
        // Attach immediately so a failure before the marker cannot escape as an
        // unhandled rejection; always abort and settle before releasing ownership.
        const settled = pending.then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
        try {
          await Promise.race([
            waitFile(marker),
            settled.then((r) => {
              if (r.error) throw r.error;
            }),
          ]);
          if (phase === "during-build")
            await new Promise((resolve) => setTimeout(resolve, 25));
          const owner = JSON.parse(
            fs.readFileSync(
              `${store}.lease/exclusive-intent/owner.json`,
              "utf8",
            ),
          );
          expect(owner.activeHelper.pid).toBe(owner.pid);
          controller.abort();
          const result = await settled;
          expect(result.error).toBeTruthy();
          expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
          expect(hashes()).toEqual(before.hashes);
          await expect(
            runFtsRefresh(runtime(), tablePath, lease!, {
              table: tablePath,
              run: true,
              expectedVersion: before.version,
            }),
          ).rejects.toThrow("acknowledge-uncertain");
          const reopened = await open();
          const version = await reopened.version();
          expect([before.version, before.version + 1]).toContain(version);
          if (phase === "after-commit")
            expect(version).toBe(before.version + 1);
          expect(await reopened.countRows()).toBe(
            128 + (phase === "during-build" ? 20_000 : 32),
          );
          expect(await reopened.indexStats("path_idx")).toEqual(
            before.pathStats,
          );
          table!.close();
          table = undefined;
          await connection!.close();
          connection = undefined;
          if (phase === "after-commit") {
            const uncertain = readFtsRefreshState(store)!;
            const checked = await runFtsRefresh(runtime(), tablePath, lease!, {
              table: tablePath,
              check: true,
              expectedVersion: version,
            });
            expect(checked.remainingRows).toBe(0);
            expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
            await runFtsRefresh(runtime(), tablePath, lease!, {
              table: tablePath,
              run: true,
              expectedVersion: version,
              acknowledgeUncertain: uncertain.attemptId,
            });
            expect(readFtsRefreshState(store)).toMatchObject({
              outcome: "completed",
              previousUncertainAttemptId: uncertain.attemptId,
              result: { afterVersion: version, newFileBytes: 0 },
            });
          }
        } finally {
          controller.abort();
          await settled;
        }
      },
      30_000,
    );
  },
);

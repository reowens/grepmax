import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const PROJECT = "/proj";

// The daemon fails closed on an unregistered root, so the registry decides
// which projectRoot a verb will serve at all.
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: (root: string) =>
    root === PROJECT ? { root, status: "indexed" } : undefined,
  listProjects: () => [{ root: PROJECT, status: "indexed" }],
}));

import type { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";
import {
  clearReadVerbs,
  registerGraphVerbs,
} from "../src/lib/daemon/read-verbs";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

class FakeSocket extends EventEmitter {
  writable = true;
  write = vi.fn(() => true);
  end = vi.fn();
}

const runSharedOperation = vi.fn(
  <T>(
    _name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ) => fn(signal ?? new AbortController().signal),
);

let dir: string;
let db: VectorDB;
let touched = 0;
let daemon: Daemon;

function record(
  id: string,
  filePath: string,
  defines: string[],
  refs: string[],
) {
  return {
    id,
    path: filePath,
    hash: `hash-${id}`,
    content: id,
    start_line: 1,
    end_line: 4,
    is_exported: true,
    defined_symbols: defines,
    referenced_symbols: refs,
    type_referenced_symbols: [],
    member_referenced_symbols: [],
    role: "function",
    vector: [1, 0, 0, 0],
    colbert: [],
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
  } as VectorRecord;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-ipc-graph-"));
  db = new VectorDB(path.join(dir, "lancedb"), 4);
  await db.insertBatch([
    record("auth", `${PROJECT}/src/auth.ts`, ["handleAuth"], []),
    record(
      "spec",
      `${PROJECT}/tests/auth.test.ts`,
      ["testLogin"],
      ["handleAuth"],
    ),
  ]);

  daemon = {
    isReady: () => true,
    operationStatus: () => "open",
    uptime: () => 1,
    listProjects: () => [{ root: PROJECT, status: "watching" }],
    resourceGenerationId: () => 1,
    hasUnfinishedRebuild: () => false,
    runSharedOperation,
    storeReadDeps: () => ({
      vectorDb: db,
      touchActivity: () => {
        touched++;
      },
    }),
  } as unknown as Daemon;

  registerGraphVerbs();
});

afterAll(async () => {
  clearReadVerbs();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function send(cmd: Record<string, unknown>) {
  // handleCommand returns null only for the streaming commands, which write
  // their own frames; every read verb answers with one response object.
  const response = await handleCommand(daemon, cmd, new FakeSocket() as never);
  if (!response) throw new Error(`${String(cmd.cmd)} returned no response`);
  return response;
}

describe("graph verbs over handleCommand", () => {
  it("routes graph.tests to the handler and answers with finished hits", async () => {
    touched = 0;
    runSharedOperation.mockClear();
    const response = await send({
      cmd: "graph.tests",
      projectRoot: PROJECT,
      symbols: ["handleAuth"],
      depth: 1,
    });

    expect(response.ok).toBe(true);
    expect(
      (response.hits as Array<{ file: string }>).map((h) => h.file),
    ).toContain(`${PROJECT}/tests/auth.test.ts`);
    // Same shared-operation route as `search`, named after the verb.
    expect(runSharedOperation.mock.calls[0][0]).toBe("graph.tests");
    expect(touched).toBe(1);
  });

  it("serves every registered graph verb", async () => {
    for (const cmd of [
      { cmd: "graph.resolve", projectRoot: PROJECT, target: "handleAuth" },
      {
        cmd: "graph.dependents",
        projectRoot: PROJECT,
        symbols: ["handleAuth"],
      },
      { cmd: "graph.trace", projectRoot: PROJECT, target: "handleAuth" },
      { cmd: "graph.peek", projectRoot: PROJECT, target: "handleAuth" },
      { cmd: "graph.dead", projectRoot: PROJECT, target: "handleAuth" },
      { cmd: "graph.audit", projectRoot: PROJECT, top: 5 },
    ]) {
      const response = await send(cmd);
      expect(response, `${cmd.cmd} should answer ok`).toMatchObject({
        ok: true,
      });
    }
  });

  it("rejects an unregistered projectRoot instead of reading the store", async () => {
    const response = await send({
      cmd: "graph.tests",
      projectRoot: "/somewhere/else",
      symbols: ["handleAuth"],
    });
    expect(response).toMatchObject({
      ok: false,
      error: "project not registered",
    });
  });

  it("rejects a scope prefix that escapes the project root", async () => {
    const response = await send({
      cmd: "graph.audit",
      projectRoot: PROJECT,
      inPrefixes: ["../etc"],
    });
    expect(response.ok).toBe(false);
    expect(String(response.error)).toMatch(/outside project root/);
  });

  it("rejects a scope prefix that is not a string", async () => {
    const response = await send({
      cmd: "graph.audit",
      projectRoot: PROJECT,
      excludePrefixes: [42],
    });
    expect(response).toMatchObject({
      ok: false,
      error: "invalid excludePrefixes",
    });
  });

  it("requires the verb's own arguments", async () => {
    await expect(
      send({ cmd: "graph.trace", projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "missing target" });
    await expect(
      send({ cmd: "graph.tests", projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "missing symbols" });
    await expect(send({ cmd: "graph.dead" })).resolves.toMatchObject({
      ok: false,
      error: "missing projectRoot",
    });
  });

  it("reports daemon-not-ready rather than crashing when the store is closed", async () => {
    const notReady = {
      ...daemon,
      storeReadDeps: () => ({ vectorDb: null, touchActivity: () => {} }),
      runSharedOperation,
    } as unknown as Daemon;
    const response = await handleCommand(
      notReady,
      { cmd: "graph.dead", projectRoot: PROJECT, target: "handleAuth" },
      new FakeSocket() as never,
    );
    if (!response) throw new Error("graph.dead returned no response");
    expect(response).toMatchObject({ ok: false, error: "daemon not ready" });
  });
});

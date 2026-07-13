import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServeHttpServer,
  listenOnLoopback,
  MAX_HTTP_SEARCH_LIMIT,
  type ServeHttpRuntime,
  serveRootError,
  waitForChildSpawn,
} from "../src/commands/serve";

describe("serve HTTP containment", () => {
  let root: string;
  let runtime: ServeHttpRuntime;
  let baseUrl: string;
  const search: any = vi.fn(async () => ({
    ok: true,
    data: [{ text: "hit" }],
  }));
  const stats = vi.fn(async () => ({ ok: true, files: 2, chunks: 3 }));

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-serve-http-"));
    fs.mkdirSync(path.join(root, "src"));
    search.mockClear();
    stats.mockClear();
    runtime = createServeHttpServer(root, { search, stats });
    const port = await listenOnLoopback(runtime.server, 0, 1);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    runtime.abortActive();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("binds only to loopback", () => {
    const address = runtime.server.address();
    expect(address).toMatchObject({ address: "127.0.0.1" });
  });

  it("forwards valid contained searches", async () => {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "auth", limit: 5, path: "src" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ text: "hit" }] });
    expect(search).toHaveBeenCalledWith(
      { query: "auth", limit: 5, pathPrefix: `${path.join(root, "src")}/` },
      expect.any(AbortSignal),
    );
  });

  it("forwards all filters and preserves repeated in/exclude values", async () => {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "auth",
        limit: 7,
        in: ["packages/api", "packages/web"],
        exclude: ["tests", "fixtures"],
        file: "handler.ts",
        lang: "ts",
        role: "ORCHESTRATION",
      }),
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(
      {
        query: "auth",
        limit: 7,
        pathPrefix: `${root}/`,
        filters: {
          file: "handler.ts",
          language: "ts",
          role: "ORCHESTRATION",
          inPrefixes: [
            `${path.join(root, "packages/api")}/`,
            `${path.join(root, "packages/web")}/`,
          ],
          excludePrefixes: [
            `${path.join(root, "tests")}/`,
            `${path.join(root, "fixtures")}/`,
          ],
        },
      },
      expect.any(AbortSignal),
    );
  });

  it("scopes searches without a path to the served project", async () => {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "auth" }),
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(
      { query: "auth", limit: 10, pathPrefix: `${root}/` },
      expect.any(AbortSignal),
    );
  });

  it("rejects paths outside the project", async () => {
    for (const candidate of ["../outside", "/"]) {
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "auth", path: candidate }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "path_outside_project" });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects invalid limits", async () => {
    for (const limit of [0, -1, 1.5, MAX_HTTP_SEARCH_LIMIT + 1, "10"]) {
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "auth", limit }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_limit" });
    }
  });

  it("rejects malformed and oversized request bodies", async () => {
    const malformed = await fetch(`${baseUrl}/search`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json" });

    const oversized = await fetch(`${baseUrl}/search`, {
      method: "POST",
      body: JSON.stringify({ query: "x".repeat(1_000_001) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "payload_too_large" });
  });

  it("maps daemon busy responses to 503", async () => {
    search.mockResolvedValueOnce({ ok: false, error: "rebuilding" });
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "auth" }),
    });
    expect(response.status).toBe(503);
  });

  it("returns project-scoped daemon stats", async () => {
    const response = await fetch(`${baseUrl}/stats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: 2, chunks: 3 });
    expect(stats).toHaveBeenCalledOnce();
  });
});

describe("serve command security helpers", () => {
  it("rejects the same blocked roots as add", () => {
    expect(serveRootError("/tmp")).toMatch(/blocked from indexing/);
    expect(serveRootError("/tmp/specific-project")).toBeUndefined();
  });

  it("rejects asynchronous spawn errors before reporting a PID", async () => {
    const child = new EventEmitter() as ChildProcess;
    const pending = waitForChildSpawn(child);
    child.emit("error", new Error("spawn EACCES"));
    await expect(pending).rejects.toThrow("spawn EACCES");
  });
});

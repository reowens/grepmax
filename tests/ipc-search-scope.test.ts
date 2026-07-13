import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/utils/project-registry")>();
  return {
    ...actual,
    listProjects: () => [
      { root: "/work/api", status: "indexed" },
      { root: "/work/web", status: "indexed" },
      { root: "/work/error", status: "error" },
    ],
  };
});

import type { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";

class FakeSocket extends EventEmitter {
  writable = true;
  write = vi.fn(() => true);
  end = vi.fn();
}

const search = vi.fn(async () => ({ ok: true, data: [] }));
const daemon = {
  isReady: () => true,
  operationStatus: () => "open",
  search,
} as unknown as Daemon;

describe("daemon search IPC scoping", () => {
  beforeEach(() => search.mockClear());

  it("accepts search-v2 only with explicit eligible roots", async () => {
    const response = await handleCommand(
      daemon,
      {
        cmd: "search-v2",
        projectRoot: "/work/api",
        query: "auth",
        limit: 10,
        filters: { projectRoots: ["/work/api", "/work/web"] },
      },
      new FakeSocket() as never,
    );

    expect(response?.ok).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });

  it("fails closed for empty or ineligible search-v2 roots", async () => {
    for (const projectRoots of [[], ["/work/error"], ["/work/orphan"]]) {
      const response = await handleCommand(
        daemon,
        {
          cmd: "search-v2",
          projectRoot: "/work/api",
          query: "auth",
          filters: { projectRoots },
        },
        new FakeSocket() as never,
      );
      expect(response?.ok).toBe(false);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects the v2 root shape on the legacy search command", async () => {
    const response = await handleCommand(
      daemon,
      {
        cmd: "search",
        projectRoot: "/work/api",
        query: "auth",
        filters: { projectRoots: ["/work/api"] },
      },
      new FakeSocket() as never,
    );

    expect(response).toMatchObject({
      ok: false,
      error: "projectRoots requires search-v2",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects path prefixes outside the selected project", async () => {
    const response = await handleCommand(
      daemon,
      {
        cmd: "search",
        projectRoot: "/work/api",
        query: "auth",
        pathPrefix: "/work/web/",
      },
      new FakeSocket() as never,
    );

    expect(response?.ok).toBe(false);
    expect(String(response?.error)).toMatch(/outside project root/i);
    expect(search).not.toHaveBeenCalled();
  });
});

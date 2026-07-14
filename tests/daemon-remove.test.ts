import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";

class FakeConnection extends EventEmitter {
  writable = true;
  writes: Array<Record<string, unknown>> = [];

  write(bytes: string): boolean {
    this.writes.push(JSON.parse(bytes.trim()));
    return true;
  }

  end(): this {
    return this;
  }
}

describe("Daemon project removal", () => {
  it("restores an existing watcher when vector deletion fails", async () => {
    const root = "/project";
    const daemon = new Daemon() as any;
    daemon.vectorDb = {
      deletePathsWithPrefix: vi.fn(async () => {
        throw Object.assign(new Error("No space left on device"), {
          code: "ENOSPC",
        });
      }),
    };
    daemon.metaCache = {
      getKeysWithPrefix: vi.fn(async () => []),
      delete: vi.fn(),
    };
    daemon.processors.set(root, {});
    vi.spyOn(daemon, "withProjectLock").mockImplementation(
      (...args: unknown[]) => (args[2] as () => Promise<void>)(),
    );
    vi.spyOn(daemon, "runSharedOperation").mockImplementation(
      (...args: unknown[]) => (args[2] as () => Promise<void>)(),
    );
    vi.spyOn(daemon, "unwatchProjectWithinOperation").mockImplementation(
      async () => {
        daemon.processors.delete(root);
      },
    );
    const restore = vi
      .spyOn(daemon, "watchProjectWithinOperation")
      .mockResolvedValue(undefined);
    const conn = new FakeConnection();

    await daemon.removeProject(root, conn as any);

    expect(restore).toHaveBeenCalledWith(root);
    expect(daemon.metaCache.delete).not.toHaveBeenCalled();
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      type: "done",
      ok: false,
      error: "No space left on device",
    });
  });
});

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MlxHealthResult,
  MlxServerManager,
} from "../src/lib/daemon/mlx-server-manager";

function makeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

function makeHarness() {
  const probeHealth = vi.fn<() => Promise<MlxHealthResult>>();
  const getPortPid = vi.fn((): number | null => null);
  const spawn = vi.fn();
  const openLog = vi.fn(() => 42);
  const closeFd = vi.fn();
  const terminateGroup = vi.fn(async () => true);
  const sleep = vi.fn(async () => {});
  const manager = new MlxServerManager({
    getShuttingDown: () => false,
    probeHealth,
    getPortPid,
    spawn,
    openLog,
    closeFd,
    terminateGroup,
    sleep,
    createOwnerToken: () => "owner-token",
  });
  return {
    manager,
    probeHealth,
    getPortPid,
    spawn,
    openLog,
    closeFd,
    terminateGroup,
    sleep,
  };
}

const unavailable: MlxHealthResult = {
  kind: "unavailable",
  reason: "down",
};
const ownedReady: MlxHealthResult = {
  kind: "healthy",
  model: "model-a",
  owner: "owner-token",
};

describe("MlxServerManager", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("coalesces concurrent ensures into one owned spawn", async () => {
    const h = makeHarness();
    const child = makeChild(1234);
    h.spawn.mockReturnValue(child);
    h.probeHealth
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(ownedReady);

    await Promise.all([
      h.manager.ensureMlxServer("model-a"),
      h.manager.ensureMlxServer("model-a"),
    ]);

    expect(h.spawn).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(h.closeFd).toHaveBeenCalledOnce();
    expect(h.manager.getStatus()).toMatchObject({
      state: "owned-ready",
      model: "model-a",
      pid: 1234,
    });
  });

  it("adopts a matching external server and never kills it", async () => {
    const h = makeHarness();
    h.probeHealth.mockResolvedValue({
      kind: "healthy",
      model: "model-a",
    });

    await h.manager.ensureMlxServer("model-a");
    expect(h.manager.getStatus().state).toBe("adopted-ready");
    await h.manager.stopMlxServer();

    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.terminateGroup).not.toHaveBeenCalled();
  });

  it("leaves a healthy wrong-model server untouched", async () => {
    const h = makeHarness();
    h.probeHealth.mockResolvedValue({
      kind: "healthy",
      model: "model-b",
    });

    await h.manager.ensureMlxServer("model-a");

    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.terminateGroup).not.toHaveBeenCalled();
    expect(h.manager.getStatus()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("model-b"),
    });
  });

  it("does not kill an unrecognized process occupying the port", async () => {
    const h = makeHarness();
    h.probeHealth.mockResolvedValue(unavailable);
    h.getPortPid.mockReturnValue(777);

    await h.manager.ensureMlxServer("model-a");

    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.terminateGroup).not.toHaveBeenCalled();
    expect(h.manager.getStatus()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("unrecognized PID 777"),
    });
  });

  it("closes the parent log descriptor on a synchronous spawn failure", async () => {
    const h = makeHarness();
    h.probeHealth.mockResolvedValue(unavailable);
    h.spawn.mockImplementation(() => {
      throw new Error("uv missing");
    });

    await h.manager.ensureMlxServer("model-a");

    expect(h.closeFd).toHaveBeenCalledExactlyOnceWith(42);
    expect(h.manager.getStatus()).toMatchObject({
      state: "failed",
      error: "uv missing",
    });
  });

  it("reaps a child that reports an asynchronous startup error", async () => {
    const h = makeHarness();
    const child = makeChild(1234);
    h.spawn.mockReturnValue(child);
    h.probeHealth.mockResolvedValue(unavailable);
    h.sleep.mockImplementationOnce(async () => {
      child.emit("error", new Error("spawn uv ENOENT"));
    });

    await h.manager.ensureMlxServer("model-a");

    expect(h.closeFd).toHaveBeenCalledOnce();
    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(h.manager.getStatus()).toMatchObject({
      state: "failed",
      error: "spawn uv ENOENT",
    });
  });

  it("fully reaps a child after startup timeout", async () => {
    const h = makeHarness();
    const child = makeChild(1234);
    h.spawn.mockReturnValue(child);
    h.probeHealth.mockResolvedValue(unavailable);

    await h.manager.ensureMlxServer("model-a");

    expect(h.sleep).toHaveBeenCalledTimes(30);
    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(h.closeFd).toHaveBeenCalledOnce();
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(h.manager.getStatus()).toMatchObject({
      state: "failed",
      error: "MLX startup timed out",
    });
  });

  it("adopts a matching server that wins the startup race", async () => {
    const h = makeHarness();
    h.spawn.mockReturnValue(makeChild(1234));
    h.probeHealth
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce({ kind: "healthy", model: "model-a" });

    await h.manager.ensureMlxServer("model-a");

    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(h.manager.getStatus().state).toBe("adopted-ready");
    h.terminateGroup.mockClear();
    await h.manager.stopMlxServer();
    expect(h.terminateGroup).not.toHaveBeenCalled();
  });

  it("coalesces concurrent stops and terminates only its owned group", async () => {
    const h = makeHarness();
    h.spawn.mockReturnValue(makeChild(1234));
    h.probeHealth
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(ownedReady);
    await h.manager.ensureMlxServer("model-a");
    h.terminateGroup.mockClear();

    await Promise.all([h.manager.stopMlxServer(), h.manager.stopMlxServer()]);

    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(h.manager.getStatus()).toMatchObject({
      state: "stopped",
      enabled: false,
    });
  });

  it("cancels and reaps an owned startup when stop races ensure", async () => {
    const h = makeHarness();
    h.spawn.mockReturnValue(makeChild(1234));
    h.probeHealth.mockResolvedValue(unavailable);
    let releaseSleep!: () => void;
    h.sleep.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    );

    const ensuring = h.manager.ensureMlxServer("model-a");
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
    const stopping = h.manager.stopMlxServer();
    releaseSleep();
    await Promise.all([ensuring, stopping]);

    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(h.manager.getStatus()).toMatchObject({
      state: "stopped",
      enabled: false,
    });
  });

  it("reaps an unhealthy owned group before respawning", async () => {
    const h = makeHarness();
    h.spawn
      .mockReturnValueOnce(makeChild(1234))
      .mockReturnValueOnce(makeChild(5678));
    h.probeHealth
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(ownedReady)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(ownedReady);
    await h.manager.ensureMlxServer("model-a");
    h.terminateGroup.mockClear();

    await h.manager.checkMlxHealth();

    expect(h.terminateGroup).toHaveBeenCalledExactlyOnceWith(1234);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.manager.getStatus()).toMatchObject({
      state: "owned-ready",
      pid: 5678,
    });
  });
});

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({
  spawnDaemon: vi.fn(async () => null),
  root: "",
}));

vi.mock("../src/config", async (original) => {
  const actual = await original<typeof import("../src/config")>();
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  h.root = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "gmax-no-daemon-"),
  );
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      globalRoot: h.root,
      daemonSocket: nodePath.join(h.root, "daemon.sock"),
      daemonPidFile: nodePath.join(h.root, "daemon.pid"),
      daemonLockFile: nodePath.join(h.root, "daemon.lock"),
      daemonDrainingFile: nodePath.join(h.root, "daemon.draining"),
    },
  };
});
vi.mock("../src/lib/workers/embeddings/gemma2", () => ({
  isGemma2Profile: () => false,
}));
vi.mock("../src/lib/utils/autostart", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/autostart")>()),
  isAutostartDisabled: () => false,
}));
vi.mock("../src/lib/utils/store-access", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/store-access")>()),
  storeWriteDeniedNotice: () => null,
}));
vi.mock("../src/lib/utils/daemon-launcher", () => ({
  spawnDaemon: h.spawnDaemon,
}));

import { daemonRequiredRefusal } from "../src/lib/utils/autostart";
import { ensureDaemonRunning } from "../src/lib/utils/daemon-client";

const hookPath = path.resolve("plugins/grepmax/hooks/watch-lease.js");
const loadHook = () => {
  const require = createRequire(import.meta.url);
  delete require.cache[hookPath];
  return require(hookPath) as { isAutostartDisabled: () => boolean };
};

describe("GMAX_NO_DAEMON=1 across commands", () => {
  beforeEach(() => {
    h.spawnDaemon.mockClear();
    vi.stubEnv("GMAX_NO_AUTOSTART", "");
    vi.stubEnv("GMAX_GEMMA_PROFILE", "");
    vi.stubEnv("GMAX_HOME", "");
    vi.stubEnv("GMAX_NO_DAEMON", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ensureDaemonRunning starts no daemon when none is running", async () => {
    expect(await ensureDaemonRunning()).toBe(false);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it("ensureDaemonRunning still starts one when the variable is unset", async () => {
    vi.stubEnv("GMAX_NO_DAEMON", "");
    expect(await ensureDaemonRunning()).toBe(false);
    expect(h.spawnDaemon).toHaveBeenCalledOnce();
  });

  it("names the variable when a command needs the daemon", () => {
    expect(daemonRequiredRefusal("gmax serve")).toContain(
      "gmax serve needs the gmax daemon, and GMAX_NO_DAEMON=1 is set",
    );
    vi.stubEnv("GMAX_NO_DAEMON", "");
    expect(daemonRequiredRefusal("gmax serve")).toBeNull();
  });

  it("keeps the session hook from starting a daemon", () => {
    expect(loadHook().isAutostartDisabled()).toBe(true);
  });
});

afterAll(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

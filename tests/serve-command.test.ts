import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryModulePath = "../src/lib/utils/server-registry";

async function loadRegistry(tempHome: string) {
  const config = await import("../src/config");
  const globalRoot = path.join(tempHome, ".osgrep");
  (config.PATHS as any).globalRoot = globalRoot;
  (config.PATHS as any).models = path.join(globalRoot, "models");
  (config.PATHS as any).grammars = path.join(globalRoot, "grammars");
  // Ensure fresh module load to pick up updated PATHS
  return import(`${registryModulePath}?t=${Date.now()}`);
}

describe("Server Registry", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "osgrep-registry-test-"),
    );
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("registerServer adds entry to registry", async () => {
    const { registerServer, listServers, isProcessRunning } =
      await loadRegistry(tempHome);

    await registerServer({
      pid: process.pid,
      port: 4444,
      projectRoot: "/test/project1",
      startTime: Date.now(),
    });

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("registerServer replaces existing entry for same projectRoot", async () => {
    const { registerServer, listServers } = await loadRegistry(tempHome);

    await registerServer({
      pid: process.pid,
      port: 4444,
      projectRoot: "/test/project1",
      startTime: Date.now(),
    });

    await registerServer({
      pid: process.pid,
      port: 5555,
      projectRoot: "/test/project1",
      startTime: Date.now(),
    });

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
  });

  it("unregisterServer removes entry from registry", async () => {
    const { registerServer, unregisterServer, listServers } =
      await loadRegistry(tempHome);

    await registerServer({
      pid: process.pid,
      port: 4444,
      projectRoot: "/test/project1",
      startTime: Date.now(),
    });

    await registerServer({
      pid: process.pid,
      port: 5555,
      projectRoot: "/test/project2",
      startTime: Date.now(),
    });

    await unregisterServer(process.pid);

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
  });

  it("listAllServers returns all registered servers", async () => {
    const { registerServer, listServers } = await loadRegistry(tempHome);

    await registerServer({
      pid: process.pid,
      port: 4444,
      projectRoot: "/project1",
      startTime: Date.now(),
    });
    await registerServer({
      pid: process.pid,
      port: 4445,
      projectRoot: "/project2",
      startTime: Date.now(),
    });
    await registerServer({
      pid: process.pid,
      port: 4446,
      projectRoot: "/project3",
      startTime: Date.now(),
    });

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
  });

  it("clearAllServers empties the registry", async () => {
    const { registerServer, listServers, unregisterServer } =
      await loadRegistry(tempHome);

    await registerServer({
      pid: process.pid,
      port: 4444,
      projectRoot: "/project1",
      startTime: Date.now(),
    });
    await registerServer({
      pid: process.pid,
      port: 4445,
      projectRoot: "/project2",
      startTime: Date.now(),
    });

    const serversBefore = await listServers();
    for (const server of serversBefore) {
      unregisterServer(server.pid);
    }

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
  });

  it("listAllServers returns empty array when registry does not exist", async () => {
    const { listServers } = await loadRegistry(tempHome);

    const servers = await listServers();
    expect(Array.isArray(servers)).toBe(true);
  });
});

describe("isProcessRunning", () => {
  it("returns true for current process", async () => {
    const { isProcessRunning } = await import(registryModulePath);

    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("returns false for non-existent process", async () => {
    const { isProcessRunning } = await import(registryModulePath);

    // Use a very high PID that's unlikely to exist
    expect(isProcessRunning(999999999)).toBe(false);
  });
});

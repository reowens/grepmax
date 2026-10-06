import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  denied: "existing host quarantine",
  setup: vi.fn(),
  grammars: vi.fn(),
  service: vi.fn(),
  registry: vi.fn(),
  database: vi.fn(),
  cache: vi.fn(),
}));
vi.mock("../src/lib/store/maintenance-policy", () => ({
  assertStoreMutationAllowed: () => {
    throw new Error(`gmax store mutation blocked: ${h.denied}`);
  },
  storeMutationDeniedReason: () => h.denied,
}));
vi.mock("../src/lib/setup/setup-helpers", () => ({ ensureSetup: h.setup }));
vi.mock("../src/lib/index/grammar-loader", () => ({
  ensureGrammars: h.grammars,
}));
vi.mock("../src/lib/index/syncer", () => ({ initialSync: h.service }));
vi.mock("../src/lib/store/vector-db", () => ({ VectorDB: h.database }));
vi.mock("../src/lib/store/meta-cache", () => ({ MetaCache: h.cache }));
vi.mock("../src/lib/utils/daemon-client", () => ({
  ensureDaemonRunning: h.service,
  sendDaemonCommand: h.service,
  sendStreamingCommand: h.service,
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: h.registry,
  listProjects: h.registry,
  registerProject: h.registry,
  removeProject: h.registry,
  getChildProjects: h.registry,
  getParentProject: h.registry,
  stampProjectFullSync: h.registry,
  resolveProjectRoot: h.registry,
  ProjectRegistryConflictError: class extends Error {},
}));
vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { add } from "../src/commands/add";
import { doctor } from "../src/commands/doctor";
import { index } from "../src/commands/index";
import { remove } from "../src/commands/remove";
import { repair } from "../src/commands/repair";

describe("CLI quarantine before resource, registry or store side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });
  it.each([
    [add, ["/synthetic/project", "--force"]],
    [add, ["/synthetic/project", "--no-index"]],
    [index, ["--reset"]],
    [index, ["--dry-run"]],
    [remove, ["/synthetic/project", "--force"]],
    [repair, ["--rebuild"]],
    [doctor, ["--fix"]],
  ] as const)(
    "refuses %s %j before any setup or mutation",
    async (command, args) => {
      await command.parseAsync([...args], { from: "user" });
      expect(process.exitCode).not.toBe(0);
      expect(console.error).toHaveBeenCalled();
      for (const fn of [
        h.setup,
        h.grammars,
        h.service,
        h.registry,
        h.database,
        h.cache,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );
});

/**
 * Routing tests for the WP-C read commands.
 *
 * The store-access policy is the whole point of these: a daemon answer is
 * rendered without opening the store, ENOENT/ECONNREFUSED (and, for one
 * release, `unknown command`) fall back in-process, and a sandbox denial
 * refuses with one actionable line and exit 2 — never a stack, never a store
 * open. `vectorDbCtor` is the tripwire: if it fires on a path that should not
 * have opened the store, the test fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const sendDaemonCommand = vi.fn();
const vectorDbCtor = vi.fn();

let projectRoot: string;
let filePath: string;

vi.mock("../src/lib/utils/daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils/daemon-client")>()),
  sendDaemonCommand: (...args: unknown[]) => sendDaemonCommand(...args),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: () => ({
    root: projectRoot,
    dataDir: path.join(projectRoot, ".gmax"),
    lancedbDir: path.join(projectRoot, ".gmax/lancedb"),
    cacheDir: path.join(projectRoot, ".gmax/cache"),
    lmdbPath: path.join(projectRoot, ".gmax/cache/meta.lmdb"),
    configPath: path.join(projectRoot, ".gmax/config.json"),
  }),
  findProjectRoot: () => projectRoot,
}));

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  resolveRootOrExit: () => projectRoot,
  listProjects: () => [{ root: projectRoot, status: "indexed" }],
  // `callGraphVerb` skips the daemon outright for a root the registry does not
  // know (extract's tests footer rides `graph.tests`), so the fixture root has
  // to look registered here too.
  getProject: (root: string) =>
    root === projectRoot ? { root, status: "indexed" } : undefined,
}));

// Constructing this is the observable proof that the in-process path ran.
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor(...args: unknown[]) {
      vectorDbCtor(...args);
    }
    async ensureTable() {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.toArray = async () => [];
      return {
        query: () => chain,
        search: () => chain,
        vectorSearch: () => chain,
      };
    }
    async close() {}
  },
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => {}),
}));

vi.mock("../src/lib/skeleton/skeletonizer", () => ({
  Skeletonizer: class {
    async init() {}
    isSupported() {
      return { supported: true };
    }
    async skeletonizeFile() {
      return {
        success: true,
        skeleton: "// generated locally",
        tokenEstimate: 4,
      };
    }
  },
}));

import { extract } from "../src/commands/extract";
import { similar } from "../src/commands/similar";
import { skeleton } from "../src/commands/skeleton";

let out: string[];
let err: string[];
const originalExitCode = process.exitCode;
const originalCwd = process.cwd();

beforeAll(() => {
  // The fixture root now looks registered (see the getProject mock), which puts
  // it in scope for the stale-generation hints; they read a real global config
  // this fixture has no business owning. Silence them, as the other command
  // tests do.
  process.env.GMAX_NO_STALE_HINT = "1";
  projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-read-routing-")),
  );
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  filePath = path.join(projectRoot, "src/auth.ts");
  fs.writeFileSync(filePath, "export function login() {\n  return 1;\n}\n");
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) =>
    out.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) =>
    err.push(a.join(" ")),
  );
  sendDaemonCommand.mockReset();
  vectorDbCtor.mockReset();
  process.exitCode = undefined;
  (extract as Command).exitOverride();
  (similar as Command).exitOverride();
  (skeleton as Command).exitOverride();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

/** Every daemon call in a run answers with the same failure. */
function daemonFails(error: string): void {
  sendDaemonCommand.mockResolvedValue({ ok: false, error });
}

describe("extract", () => {
  const run = (args: string[] = []) =>
    (extract as Command).parseAsync(["login", ...args], { from: "user" });

  it("renders the daemon's rows without opening the store", async () => {
    sendDaemonCommand.mockImplementation(async (cmd: { cmd: string }) => {
      if (cmd.cmd === "rows.locate") {
        return {
          ok: true,
          rows: [
            [
              {
                path: filePath,
                start_line: 0,
                end_line: 2,
                role: "IMPLEMENTATION",
                is_exported: true,
                defined_symbols: ["login"],
              },
            ],
          ],
        };
      }
      if (cmd.cmd === "graph.tests") return { ok: true, hits: [] };
      return { ok: false, error: "unexpected" };
    });

    await run(["--agent"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("src/auth.ts:1-3");
    expect(out.join("\n")).toContain("export function login()");
  });

  it("refuses with the socket hint and exit 2 when the sandbox blocks the socket", async () => {
    daemonFails("EPERM");

    await run(["--agent"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("allowUnixSockets");
    expect(err[0]).not.toContain("\n    at ");
    expect(process.exitCode).toBe(2);
  });

  it("falls back in-process only when nothing is listening", async () => {
    daemonFails("ENOENT");
    await run(["--agent"]);
    expect(vectorDbCtor).toHaveBeenCalled();
  });

  it("falls back for one release when the daemon does not know the verb", async () => {
    daemonFails("unknown command: rows.locate");
    await run(["--agent"]);
    expect(vectorDbCtor).toHaveBeenCalled();
  });

  it("never opens the store after a live-daemon error", async () => {
    daemonFails("DAEMON_BUSY");
    await run(["--agent"]);
    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Extract failed:");
    expect(process.exitCode).toBe(1);
  });
});

describe("similar", () => {
  const run = (args: string[] = []) =>
    (similar as Command).parseAsync(["src/auth.ts", ...args], { from: "user" });

  it("renders the daemon's ranked chunks without opening the store", async () => {
    sendDaemonCommand.mockResolvedValue({
      ok: true,
      status: "ok",
      results: [
        {
          path: path.join(projectRoot, "src/session.ts"),
          start_line: 4,
          end_line: 9,
          defined_symbols: ["session"],
          role: "IMPLEMENTATION",
          _distance: 0.25,
        },
      ],
    });

    await run(["--agent"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain(
      "src/session.ts:5\tsession\t[IMPL]\td=0.250",
    );
  });

  it("refuses with the socket hint when the sandbox blocks the socket", async () => {
    daemonFails("EACCES");

    await run(["--agent"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err).toEqual([expect.stringContaining("allowUnixSockets")]);
    expect(process.exitCode).toBe(2);
  });

  it("falls back in-process on ECONNREFUSED", async () => {
    daemonFails("ECONNREFUSED");
    await run(["--agent"]);
    expect(vectorDbCtor).toHaveBeenCalled();
  });

  it("does not fall back on a scope error from a live daemon", async () => {
    daemonFails("invalid path prefix");
    await run(["--agent"]);
    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Similar search failed:");
  });
});

describe("skeleton", () => {
  const run = (args: string[]) =>
    (skeleton as Command).parseAsync(args, { from: "user" });

  beforeEach(() => {
    process.chdir(projectRoot);
  });

  it("prints the daemon's stored skeleton without opening the store", async () => {
    sendDaemonCommand.mockResolvedValue({
      ok: true,
      path: filePath,
      skeleton: "function login(): number",
    });

    await run(["src/auth.ts"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("function login(): number");
  });

  it("refuses with the socket hint when the sandbox blocks the socket", async () => {
    daemonFails("EPERM");

    await run(["src/auth.ts"]);

    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err).toEqual([expect.stringContaining("allowUnixSockets")]);
    expect(process.exitCode).toBe(2);
  });

  it("falls back in-process when nothing is listening, then skeletonizes locally", async () => {
    daemonFails("ENOENT");

    await run(["src/auth.ts"]);

    expect(vectorDbCtor).toHaveBeenCalled();
    expect(out.join("\n")).toContain("// generated locally");
  });
});

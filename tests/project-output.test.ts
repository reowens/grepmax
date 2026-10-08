import { afterEach, expect, it, vi } from "vitest";
import { project } from "../src/commands/project";
import {
  projectCounts,
  projectCoverageNotice,
} from "../src/lib/output/project-coverage";
import { withStoreRead } from "../src/lib/utils/store-access";

vi.mock("../src/lib/utils/project-registry", () => ({
  resolveRootOrExit: () => "/repo/app",
  listProjects: () => [],
}));
vi.mock("../src/lib/utils/project-root", () => ({
  findProjectRoot: () => "/repo/app",
  ensureProjectPaths: () => ({ lancedbDir: "/unused" }),
}));
vi.mock("../src/lib/utils/store-access", () => ({
  withStoreRead: vi.fn(),
  reportStoreAccessRefusal: () => false,
}));
vi.mock("../src/lib/utils/exit", () => ({ gracefulExit: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it.each([false, true])(
  "discloses sampled aggregates in CLI output (agent=%s)",
  async (agent) => {
    vi.mocked(withStoreRead).mockResolvedValue({
      sampled: true,
      chunks: 200000,
      files: 17,
      totalChunks: 200050,
      extEntries: [[".ts", 200000]],
      dirEntries: [],
      roleEntries: [],
      topSymbols: [],
      entryPoints: [],
    });
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    project.setOptionValue("agent", false);
    await project.parseAsync(["node", "gmax", ...(agent ? ["--agent"] : [])]);
    const text = logged.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(text).toContain("200050 total chunks");
    expect(text).toContain("all breakdowns below describe the sample");
    if (agent) {
      expect(text).toMatch(/^name\tapp/);
      expect(text).toContain("coverage\tpartial:");
    } else {
      expect(text).toContain("200000 sampled chunks • 17 sampled files");
      expect(text).toContain("Coverage: partial:");
      expect(text).not.toContain("coverage\t");
    }
  },
);
it("preserves exact labels for uncapped data and avoids an invented total", () => {
  expect(projectCounts({ chunks: 3, files: 2 })).toBe("3 chunks • 2 files");
  expect(projectCoverageNotice({ chunks: 3, files: 2 })).toBeNull();
  expect(
    projectCoverageNotice({ chunks: 3, files: 2, sampled: true }),
  ).toContain("total chunk count unavailable");
});

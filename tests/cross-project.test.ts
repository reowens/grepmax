import { describe, expect, it, vi } from "vitest";
import {
  groupResultsByProject,
  projectForPath,
  resolveCrossProjectScope,
} from "../src/lib/utils/cross-project";

const projects = [
  { name: "api", root: "/work/api", status: "indexed" as const },
  { name: "gateway", root: "/work/gateway", status: "indexed" as const },
  { name: "legacy", root: "/work/legacy", status: "error" as const },
];

vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: () =>
    projects.map((p) => ({
      ...p,
      vectorDim: 384,
      modelTier: "small",
      embedMode: "auto",
      lastIndexed: "2026-01-01T00:00:00Z",
    })),
}));

describe("resolveCrossProjectScope", () => {
  it("is inert when no cross-project flags are passed", () => {
    const scope = resolveCrossProjectScope({});
    expect(scope.active).toBe(false);
    expect(scope.roots).toEqual([]);
    expect(scope.projectRoots).toEqual([]);
  });

  it("--all-projects scopes to every non-error project explicitly", () => {
    const scope = resolveCrossProjectScope({ allProjects: true });
    expect(scope.active).toBe(true);
    // error-status "legacy" is excluded.
    expect(scope.roots.map((r) => r.name)).toEqual(["api", "gateway"]);
    expect(scope.projectRoots).toEqual(["/work/api", "/work/gateway"]);
    expect(scope.projectRootsCsv).toBe("/work/api,/work/gateway");
    expect(scope.excludeProjectRootsCsv).toBeUndefined();
  });

  it("--projects narrows to a subset via project_roots", () => {
    const scope = resolveCrossProjectScope({ projects: "api" });
    expect(scope.active).toBe(true);
    expect(scope.roots.map((r) => r.name)).toEqual(["api"]);
    expect(scope.projectRoots).toEqual(["/work/api"]);
    expect(scope.projectRootsCsv).toBe("/work/api");
  });

  it("--projects warns on unknown names but keeps the resolved ones", () => {
    const scope = resolveCrossProjectScope({ projects: "api,nope" });
    expect(scope.roots.map((r) => r.name)).toEqual(["api"]);
    expect(scope.projectRootsCsv).toBe("/work/api");
    expect(scope.warnings.join(" ")).toContain("nope");
  });

  it("--all-projects --exclude-projects carves out via exclude_project_roots", () => {
    const scope = resolveCrossProjectScope({
      allProjects: true,
      excludeProjects: "gateway",
    });
    expect(scope.roots.map((r) => r.name)).toEqual(["api"]);
    expect(scope.projectRoots).toEqual(["/work/api"]);
    expect(scope.excludeProjectRootsCsv).toBe("/work/gateway");
    expect(scope.projectRootsCsv).toBe("/work/api");
  });

  it("--projects minus --exclude-projects collapses to project_roots", () => {
    const scope = resolveCrossProjectScope({
      projects: "api,gateway",
      excludeProjects: "gateway",
    });
    expect(scope.roots.map((r) => r.name)).toEqual(["api"]);
    expect(scope.projectRootsCsv).toBe("/work/api");
  });
});

describe("projectForPath", () => {
  const roots = [
    { name: "api", root: "/work/api" },
    { name: "api-extra", root: "/work/api-extra" },
  ];

  it("matches the longest root prefix (no false sibling match)", () => {
    expect(projectForPath("/work/api-extra/src/x.ts", roots)?.name).toBe(
      "api-extra",
    );
    expect(projectForPath("/work/api/src/x.ts", roots)?.name).toBe("api");
  });

  it("returns null for an out-of-scope path", () => {
    expect(projectForPath("/somewhere/else.ts", roots)).toBeNull();
  });
});

describe("groupResultsByProject", () => {
  const roots = [
    { name: "api", root: "/work/api" },
    { name: "gateway", root: "/work/gateway" },
  ];
  const getPath = (r: { path: string }) => r.path;

  it("buckets by owning project, ordered by best-ranked member", () => {
    const results = [
      { path: "/work/gateway/a.ts" }, // best rank → gateway first
      { path: "/work/api/b.ts" },
      { path: "/work/gateway/c.ts" },
    ];
    const groups = groupResultsByProject(results, roots, getPath);
    expect(groups.map((g) => g.name)).toEqual(["gateway", "api"]);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("files outside any in-scope root fall into an (unknown) bucket", () => {
    const groups = groupResultsByProject(
      [{ path: "/orphan/x.ts" }],
      roots,
      getPath,
    );
    expect(groups[0].name).toBe("(unknown)");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveScope } from "../src/lib/utils/scope-filter";

describe("resolveScope", () => {
  it("defaults to projectRoot/ when no --in/--exclude given", () => {
    const r = resolveScope({ projectRoot: "/p/app" });
    expect(r.pathPrefix).toBe("/p/app/");
    expect(r.inPrefixes).toEqual([]);
    expect(r.excludePrefixes).toEqual([]);
  });

  it("collapses a single --in into pathPrefix", () => {
    const r = resolveScope({ projectRoot: "/p/app", in: "packages/api" });
    expect(r.pathPrefix).toBe("/p/app/packages/api/");
    expect(r.inPrefixes).toEqual([]);
  });

  it("keeps multi-`--in` as inPrefixes (OR clause source)", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      in: ["packages/api", "packages/web"],
    });
    expect(r.pathPrefix).toBe("/p/app/");
    expect(r.inPrefixes).toEqual([
      "/p/app/packages/api/",
      "/p/app/packages/web/",
    ]);
  });

  it("splits comma-separated --in values", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      in: "packages/api,packages/web",
    });
    expect(r.inPrefixes).toEqual([
      "/p/app/packages/api/",
      "/p/app/packages/web/",
    ]);
  });

  it("resolves multiple --exclude values relative to project root", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      exclude: ["tests", "docs"],
    });
    expect(r.excludePrefixes).toEqual(["/p/app/tests/", "/p/app/docs/"]);
  });

  it("accepts an absolute --in subpath unchanged", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      in: "/p/app/packages/api",
    });
    expect(r.pathPrefix).toBe("/p/app/packages/api/");
  });

  it("accepts a subpath that already starts with the projectRoot", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      exclude: "/p/app/tests/",
    });
    expect(r.excludePrefixes).toEqual(["/p/app/tests/"]);
  });

  it("rejects relative scopes that escape the project", () => {
    expect(() =>
      resolveScope({ projectRoot: "/p/app", in: "../other" }),
    ).toThrow(/outside project root/i);
    expect(() =>
      resolveScope({ projectRoot: "/p/app", exclude: "../../private" }),
    ).toThrow(/outside project root/i);
  });

  it("rejects absolute scopes outside the project", () => {
    expect(() =>
      resolveScope({ projectRoot: "/p/app", in: "/p/other" }),
    ).toThrow(/outside project root/i);
  });

  it("rejects sibling-prefix collisions", () => {
    expect(() =>
      resolveScope({ projectRoot: "/p/app", in: "/p/application/src" }),
    ).toThrow(/outside project root/i);
  });
});

describe("resolveScope with a nested base", () => {
  it("resolves relative --in against the base, not the project root", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      base: "/p/app/subrepo",
      in: "src",
    });
    expect(r.pathPrefix).toBe("/p/app/subrepo/src/");
  });

  it("resolves relative --exclude against the base", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      base: "/p/app/subrepo",
      exclude: "tests",
    });
    expect(r.excludePrefixes).toEqual(["/p/app/subrepo/tests/"]);
  });

  it("keeps absolute subpaths untouched by the base", () => {
    const r = resolveScope({
      projectRoot: "/p/app",
      base: "/p/app/subrepo",
      in: "/p/app/other/src",
    });
    expect(r.pathPrefix).toBe("/p/app/other/src/");
  });

  it("still enforces containment against the project root", () => {
    expect(() =>
      resolveScope({
        projectRoot: "/p/app",
        base: "/p/app/subrepo",
        in: "../../outside",
      }),
    ).toThrow(/outside project root/i);
  });

  describe("existence fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-scope-"));
    const root = path.join(tmp, "root");
    const base = path.join(root, "subrepo");
    fs.mkdirSync(path.join(base, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "sibling"), { recursive: true });

    afterAll(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("prefers the base-relative path when it exists", () => {
      const r = resolveScope({ projectRoot: root, base, in: "src" });
      expect(r.pathPrefix).toBe(`${path.join(base, "src")}/`);
    });

    it("falls back to root-relative when only that exists", () => {
      const r = resolveScope({ projectRoot: root, base, in: "sibling" });
      expect(r.pathPrefix).toBe(`${path.join(root, "sibling")}/`);
    });

    it("keeps the base-relative path when neither exists", () => {
      const r = resolveScope({ projectRoot: root, base, in: "nope" });
      expect(r.pathPrefix).toBe(`${path.join(base, "nope")}/`);
    });
  });
});

import { describe, expect, it } from "vitest";
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
});

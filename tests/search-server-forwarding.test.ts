import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeServerSearch,
  renderSearchOutput,
} from "../src/commands/search-output";
import type { SearchOptions } from "../src/commands/search-run";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search HTTP fast path", () => {
  it("forwards every supported search scope and filter", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        ({ ok: false }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const handled = await executeServerSearch({
      server: { port: 4444 },
      pattern: "auth flow",
      exec_path: "/repo/src",
      projectRootForServer: "/repo",
      options: {
        m: "8",
        in: ["packages/api", "packages/web"],
        exclude: ["tests", "fixtures"],
        file: "handler.ts",
        lang: "ts",
        role: "ORCHESTRATION",
      } as SearchOptions,
      minScore: 0,
    });

    expect(handled).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "auth flow",
      limit: 8,
      path: "src",
      in: ["packages/api", "packages/web"],
      exclude: ["tests", "fixtures"],
      file: "handler.ts",
      lang: "ts",
      role: "ORCHESTRATION",
    });
  });

  it("does not read a context result replaced by an escaping symlink", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-cli-context-"));
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const indexedPath = path.join(root, "source.ts");
    const secretPath = path.join(outside, "secret.ts");
    fs.writeFileSync(secretPath, "DO_NOT_DISCLOSE");
    fs.symlinkSync(secretPath, indexedPath);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await renderSearchOutput({
        searchResult: {
          data: [
            {
              type: "text",
              text: "stale indexed content",
              metadata: { path: indexedPath, hash: "" },
              generated_metadata: { start_line: 0, end_line: 0 },
              score: 1,
            },
          ],
        },
        options: {
          m: "5",
          budget: "1000",
          contextForLlm: true,
        } as SearchOptions,
        minScore: 0,
        crossProject: { active: false } as never,
        pattern: "secret",
        effectiveRoot: root,
        projectRoot: root,
        vectorDb: null,
      });

      expect(log.mock.calls.flat().join("\n")).not.toContain("DO_NOT_DISCLOSE");
    } finally {
      log.mockRestore();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    "outside path",
    "post-index symlink replacement",
  ])("does not extract imports from an %s", async (scenario) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-imports-"));
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const secretPath = path.join(outside, "secret.ts");
    fs.writeFileSync(secretPath, 'import secret from "DO_NOT_DISCLOSE";\n');
    const indexedPath = path.join(root, "source.ts");
    if (scenario === "post-index symlink replacement") {
      fs.writeFileSync(indexedPath, "export const safe = true;\n");
      fs.unlinkSync(indexedPath);
      fs.symlinkSync(secretPath, indexedPath);
    }
    const resultPath = scenario === "outside path" ? secretPath : indexedPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await renderSearchOutput({
        searchResult: {
          data: [
            {
              type: "text",
              text: "export const stale = true;",
              metadata: { path: resultPath, hash: "" },
              generated_metadata: { start_line: 0, end_line: 0 },
              score: 1,
            },
          ],
        },
        options: { m: "5", agent: true, imports: true } as SearchOptions,
        minScore: 0,
        crossProject: { active: false } as never,
        pattern: "stale",
        effectiveRoot: root,
        projectRoot: root,
        vectorDb: null,
      });

      expect(log.mock.calls.flat().join("\n")).not.toContain("DO_NOT_DISCLOSE");
    } finally {
      log.mockRestore();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

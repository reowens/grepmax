import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IgnorePolicyReadError,
  ProjectFilePolicy,
} from "../src/lib/index/file-policy";
import { createWalkState, walk } from "../src/lib/index/walker";

describe("ProjectFilePolicy", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-policy-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, content = "export const value = 1;\n") {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  }

  it.each([
    ["src/main.ts", "indexable"],
    ["secrets.ts", "excluded"],
    ["credentials.json", "excluded"],
    ["src/schema.generated.ts", "excluded"],
    ["fixtures/example.ts", "excluded"],
    ["node_modules/pkg/index.ts", "excluded"],
  ])("classifies %s as %s", async (relative, status) => {
    const target = write(relative);
    const policy = new ProjectFilePolicy(root);
    expect((await policy.classifyFile(target)).status).toBe(status);
  });

  it("applies additive nested ignore files", async () => {
    write(".gitignore", "ignored-root.ts\n");
    write("packages/api/.gmaxignore", "private.ts\n");
    const rootIgnored = write("ignored-root.ts");
    const nestedIgnored = write("packages/api/private.ts");
    const included = write("packages/api/public.ts");
    const policy = new ProjectFilePolicy(root);

    expect((await policy.classifyFile(rootIgnored)).status).toBe("excluded");
    expect((await policy.classifyFile(nestedIgnored)).status).toBe("excluded");
    expect((await policy.classifyFile(included)).status).toBe("indexable");
  });

  it("invalidates cached ignore policy", async () => {
    const target = write("src/private.ts");
    const policy = new ProjectFilePolicy(root);
    expect((await policy.classifyFile(target)).status).toBe("indexable");

    write(".gitignore", "src/private.ts\n");
    expect((await policy.classifyFile(target)).status).toBe("indexable");
    policy.invalidateIgnoreCache();
    expect((await policy.classifyFile(target)).status).toBe("excluded");
  });

  it("returns an error when ignore policy cannot be read authoritatively", async () => {
    const target = write("src/main.ts");
    const policy = new ProjectFilePolicy(root);
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    const policyError = new IgnorePolicyReadError(root, error);
    (policy as any).loadIgnoreScope = async () => {
      throw policyError;
    };

    const result = await policy.classifyFile(target);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.protectedPath).toBe(root);
      expect(result.error).toBe(policyError);
    }
  });

  it("evicts rejected ignore reads so a transient failure can recover", async () => {
    const target = write("src/main.ts");
    const policy = new ProjectFilePolicy(root);
    const originalRead = fs.promises.readFile.bind(fs.promises);
    let failed = false;
    const readSpy = vi
      .spyOn(fs.promises, "readFile")
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.readFile>) => {
          if (!failed && String(args[0]).endsWith(".gitignore")) {
            failed = true;
            const error = new Error(
              "temporary I/O failure",
            ) as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
          return originalRead(...(args as [fs.PathLike, any]));
        },
      );

    expect((await policy.classifyFile(target)).status).toBe("error");
    expect((await policy.classifyFile(target)).status).toBe("indexable");
    readSpy.mockRestore();
  });

  it("distinguishes missing paths and outside paths", async () => {
    const policy = new ProjectFilePolicy(root);
    expect(
      (await policy.classifyFile(path.join(root, "missing.ts"))).status,
    ).toBe("missing");
    expect(
      (await policy.classifyFile(path.join(path.dirname(root), "outside.ts")))
        .status,
    ).toBe("excluded");
  });

  it("traverses a symlinked project root without allowing descendant symlinks", async () => {
    const source = write("src/main.ts");
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias, "dir");
    try {
      const policy = new ProjectFilePolicy(alias);
      const state = createWalkState();
      const files: string[] = [];
      for await (const file of walk(alias, { policy, state })) files.push(file);

      expect(files).toEqual([path.relative(root, source)]);
      expect(state.rootComplete).toBe(true);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it("turns an unavailable root into an incomplete scan instead of throwing", async () => {
    const missingRoot = path.join(root, "unavailable");
    const policy = new ProjectFilePolicy(missingRoot);
    const state = createWalkState();
    const files: string[] = [];
    for await (const file of walk(missingRoot, { policy, state })) {
      files.push(file);
    }

    expect(files).toEqual([]);
    expect(state.rootComplete).toBe(false);
  });
});

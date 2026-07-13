import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-symlink-policy-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("file-policy symlink containment", () => {
  it("rejects internal and external file symlinks", async () => {
    const root = temp();
    const outside = temp();
    fs.writeFileSync(path.join(root, "real.ts"), "export const real = 1;");
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    fs.symlinkSync(path.join(root, "real.ts"), path.join(root, "internal.ts"));
    fs.symlinkSync(
      path.join(outside, "secret.ts"),
      path.join(root, "external.ts"),
    );
    const policy = new ProjectFilePolicy(root);

    expect(
      (await policy.classifyFile(path.join(root, "internal.ts"))).status,
    ).toBe("excluded");
    expect(
      (await policy.classifyFile(path.join(root, "external.ts"))).status,
    ).toBe("excluded");
  });

  it("rejects symlink directories and descendants", async () => {
    const root = temp();
    const outside = temp();
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    fs.symlinkSync(outside, path.join(root, "linked"));
    const policy = new ProjectFilePolicy(root);

    expect(
      (await policy.classifyDirectory(path.join(root, "linked"))).status,
    ).toBe("excluded");
    expect(
      (await policy.classifyFile(path.join(root, "linked", "secret.ts")))
        .status,
    ).toBe("excluded");
  });

  it("rejects broken symlinks deterministically", async () => {
    const root = temp();
    fs.symlinkSync(path.join(root, "missing.ts"), path.join(root, "broken.ts"));
    const policy = new ProjectFilePolicy(root);
    expect(
      (await policy.classifyFile(path.join(root, "broken.ts"))).status,
    ).toBe("excluded");
  });
});

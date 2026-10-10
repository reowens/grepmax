import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyBoundedRuntimeAt } from "../src/lib/store/bounded-runtime";

describe("bundled bounded cleanup runtime verification", () => {
  let root: string;
  const platform = "darwin-arm64";
  const name = `gmax-bounded-maintenance-${platform}`;
  const capabilities = {
    protocolVersion: 1,
    engine: "12.0.0",
    budgetKind: "cumulative-writes",
    protectedReaderProtocol: 1,
    nativeTotalWriteBudgetEnforced: true,
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-bounded-runtime-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function fixture(report: object = capabilities) {
    const executable = path.join(root, name);
    const code = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`;
    fs.writeFileSync(executable, code, { mode: 0o700 });
    const manifest = {
      schemaVersion: 1,
      engine: "12.0.0",
      sourceSha256: "a".repeat(64),
      qualified: true,
      binaries: {
        [platform]: {
          file: name,
          sha256: createHash("sha256").update(code).digest("hex"),
        },
      },
    };
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify(manifest),
    );
    return { executable, manifest };
  }

  it("requires an explicit qualified capability before enabling incremental repair", async () => {
    const { executable } = fixture({
      ...capabilities,
      incrementalRepairProtocol: 1,
    });
    expect(await verifyBoundedRuntimeAt(root, platform)).toEqual({
      executable,
      incrementalRepairProtocol: 1,
    });
    fixture({ ...capabilities, incrementalRepairProtocol: 2 });
    await expect(verifyBoundedRuntimeAt(root, platform)).rejects.toThrow(
      /capabilities unverified/,
    );
  });

  it("leaves unsupported or absent runtimes unavailable", async () => {
    expect(await verifyBoundedRuntimeAt(root, platform)).toBeNull();
    fixture();
    expect(await verifyBoundedRuntimeAt(root, "win32-x64")).toBeNull();
  });

  it("refuses to run qualification-only artifacts", async () => {
    const { manifest, executable } = fixture();
    manifest.qualified = false;
    fs.unlinkSync(executable);
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify(manifest),
    );
    expect(await verifyBoundedRuntimeAt(root, platform)).toBeNull();
  });

  it("verifies both the installed bytes and executable protocol", async () => {
    const { executable } = fixture();
    expect(await verifyBoundedRuntimeAt(root, platform)).toEqual({
      executable,
    });
    fs.appendFileSync(executable, "// tampered\n");
    await expect(verifyBoundedRuntimeAt(root, platform)).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  it("rejects a matching checksum with missing native enforcement", async () => {
    fixture({ ...capabilities, nativeTotalWriteBudgetEnforced: false });
    await expect(verifyBoundedRuntimeAt(root, platform)).rejects.toThrow(
      /capabilities unverified/,
    );
  });

  it("rejects executable symlinks and traversal entries", async () => {
    const { executable, manifest } = fixture();
    fs.renameSync(executable, `${executable}.target`);
    fs.symlinkSync(`${executable}.target`, executable);
    await expect(verifyBoundedRuntimeAt(root, platform)).rejects.toThrow(
      /Unverified.*binary/,
    );
    manifest.binaries[platform].file = "../outside";
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify(manifest),
    );
    await expect(verifyBoundedRuntimeAt(root, platform)).rejects.toThrow(
      /Invalid.*binary entry/,
    );
  });

  it("honors cancellation before opening or executing files", async () => {
    fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancel before runtime"));
    await expect(
      verifyBoundedRuntimeAt(root, platform, controller.signal),
    ).rejects.toThrow("cancel before runtime");
  });
});

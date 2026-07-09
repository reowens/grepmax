import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMlxModelCached,
  resolveMlxHfHome,
} from "../src/lib/utils/mlx-hf-cache";

const MODEL_ID = "test-org/test-embed-model";
const MODEL_DIR_NAME = "models--test-org--test-embed-model";

function makeSourceCache(root: string): string {
  const modelDir = path.join(root, "hub", MODEL_DIR_NAME);
  const blobDir = path.join(modelDir, "blobs");
  const snapDir = path.join(modelDir, "snapshots", "abc123");
  fs.mkdirSync(blobDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "deadbeef"), "weights");
  // HF hub layout: snapshot files are relative symlinks into blobs/
  fs.symlinkSync(
    path.join("..", "..", "blobs", "deadbeef"),
    path.join(snapDir, "model.safetensors"),
  );
  return root;
}

describe("resolveMlxHfHome", () => {
  let tmp: string;
  let localHfHome: string;
  let inheritedHfHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-hf-test-"));
    localHfHome = path.join(tmp, "local-hf");
    inheritedHfHome = path.join(tmp, "inherited-hf");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("seeds the local cache from the inherited cache", () => {
    makeSourceCache(inheritedHfHome);
    const result = resolveMlxHfHome(MODEL_ID, { localHfHome, inheritedHfHome });
    expect(result).toBe(localHfHome);
    const copied = path.join(
      localHfHome,
      "hub",
      MODEL_DIR_NAME,
      "snapshots",
      "abc123",
      "model.safetensors",
    );
    // Relative snapshot->blob symlink survives the copy and resolves locally
    expect(fs.readFileSync(copied, "utf8")).toBe("weights");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
  });

  it("short-circuits when the local cache already has a snapshot", () => {
    makeSourceCache(inheritedHfHome);
    resolveMlxHfHome(MODEL_ID, { localHfHome, inheritedHfHome });
    // Wipe the source; a second resolve must not need (or touch) it
    fs.rmSync(inheritedHfHome, { recursive: true, force: true });
    const result = resolveMlxHfHome(MODEL_ID, { localHfHome, inheritedHfHome });
    expect(result).toBe(localHfHome);
  });

  it("returns the local cache dir even when the inherited cache is missing", () => {
    const result = resolveMlxHfHome(MODEL_ID, {
      localHfHome,
      inheritedHfHome: path.join(tmp, "does-not-exist"),
    });
    expect(result).toBe(localHfHome);
    // hub dir is created so the server can download into it
    expect(fs.existsSync(path.join(localHfHome, "hub"))).toBe(true);
    // but no model dir appears out of thin air
    expect(fs.existsSync(path.join(localHfHome, "hub", MODEL_DIR_NAME))).toBe(
      false,
    );
  });

  it("leaves no .seed-* temp dir behind after seeding", () => {
    makeSourceCache(inheritedHfHome);
    resolveMlxHfHome(MODEL_ID, { localHfHome, inheritedHfHome });
    const leftovers = fs
      .readdirSync(path.join(localHfHome, "hub"))
      .filter((name) => name.startsWith(".seed-"));
    expect(leftovers).toEqual([]);
  });
});

describe("isMlxModelCached", () => {
  let tmp: string;
  let localHfHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-hf-cached-"));
    localHfHome = path.join(tmp, "local-hf");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is true when the model has a snapshot in the local HF cache", () => {
    makeSourceCache(localHfHome);
    expect(isMlxModelCached(MODEL_ID, localHfHome)).toBe(true);
  });

  it("is false when the cache dir is absent entirely", () => {
    expect(isMlxModelCached(MODEL_ID, localHfHome)).toBe(false);
  });

  it("is false when the model dir exists but has no snapshots", () => {
    fs.mkdirSync(path.join(localHfHome, "hub", MODEL_DIR_NAME, "snapshots"), {
      recursive: true,
    });
    expect(isMlxModelCached(MODEL_ID, localHfHome)).toBe(false);
  });
});

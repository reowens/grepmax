import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../config";
import { log } from "./logger";

/** Default model served by mlx-embed-server/server.py (keep in sync). */
export const DEFAULT_MLX_EMBED_MODEL =
  "ibm-granite/granite-embedding-small-english-r2";

function hasSnapshot(modelDir: string): boolean {
  try {
    return fs.readdirSync(path.join(modelDir, "snapshots")).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the HF_HOME to spawn the MLX embed server with, pinned to internal
 * disk (~/.gmax/hf).
 *
 * The user's shell HF_HOME — and even ~/.cache/huggingface, which may itself
 * be a symlink — can live on an external volume. When that volume is
 * unmounted the embed server dies at model load (PermissionError on the dead
 * mountpoint) and every worker silently degrades to ONNX CPU. The embed
 * model is small (~185MB), so keeping a private copy under ~/.gmax/hf makes
 * the server immune to drive state and shell env.
 *
 * Seeds the local cache from the inherited HF cache when the model is
 * already there (one-time `cp -R`, preserves the hub layout's relative
 * snapshot→blob symlinks) so the first spawn needs no network. Otherwise the
 * server downloads into the local cache on startup. Copies land in a temp
 * dir and are renamed into place so a partial copy never looks complete —
 * server.py flips to offline mode whenever the model dir is non-empty.
 */
export function resolveMlxHfHome(
  modelId: string = DEFAULT_MLX_EMBED_MODEL,
  opts: { localHfHome?: string; inheritedHfHome?: string } = {},
): string {
  const localHfHome = opts.localHfHome ?? PATHS.hfDir;
  const hubDir = path.join(localHfHome, "hub");
  const modelDirName = `models--${modelId.replace(/\//g, "--")}`;
  const localModelDir = path.join(hubDir, modelDirName);
  try {
    fs.mkdirSync(hubDir, { recursive: true });
  } catch {}
  if (hasSnapshot(localModelDir)) return localHfHome;

  const inherited =
    opts.inheritedHfHome ??
    process.env.HF_HOME ??
    path.join(os.homedir(), ".cache", "huggingface");
  const sourceModelDir = path.join(inherited, "hub", modelDirName);
  const tmpDir = path.join(hubDir, `.seed-${modelDirName}`);
  try {
    if (hasSnapshot(sourceModelDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      execFileSync("cp", ["-R", sourceModelDir, tmpDir], { timeout: 300_000 });
      fs.renameSync(tmpDir, localModelDir);
      log("mlx", `seeded local HF cache for ${modelId} from ${sourceModelDir}`);
    }
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    log(
      "mlx",
      `local HF cache seed failed (${err instanceof Error ? err.message : String(err)}) — model will download on first server start`,
    );
  }
  return localHfHome;
}

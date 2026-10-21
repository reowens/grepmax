import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// One shipped contract is read by both runtimes. Its canonical JSON binds the
// checkpoint, tokenizer, backend, prompt routing and truncation to the index.
const contract =
  require("../../../../mlx-embed-server/gemma-contract.json") as {
    model: string;
    queryCode: string;
    queryDocument: string;
    queryTestsPattern: string;
    queryDocumentationPattern: string;
  };
export const GEMMA2_MODEL = contract.model;
export const GEMMA2_CONTRACT_DIGEST = createHash("sha256")
  .update(JSON.stringify(contract))
  .digest("hex");

export function gemma2Query(text: string): string {
  const documentation = new RegExp(
    contract.queryDocumentationPattern,
    "i",
  ).test(text);
  const tests = new RegExp(contract.queryTestsPattern, "i").test(text);
  return `${documentation && !tests ? contract.queryDocument : contract.queryCode}${text}`;
}

export function gemma2Document(
  text: string,
  projectRoot: string,
  file: string,
): string {
  const relative = path.relative(projectRoot, path.resolve(projectRoot, file));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Gemma document must belong to its project");
  const title = `${path.basename(projectRoot)}/${relative.split(path.sep).join("/")}`;
  return `title: ${title} | text: ${text}`;
}

/** Experimental Gemma never shares the live Granite store or daemon. */
export function assertGemma2Profile(
  config: { modelTier: string; embedMode: string },
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): void {
  if (env.GMAX_GEMMA_PROFILE === "1" && config.modelTier !== "gemma2")
    throw new Error(
      "Gemma profile requires the configured gemma2 tier; run gmax config --model-tier gemma2 --embed-mode gpu",
    );
  if (config.modelTier !== "gemma2") return;
  const canonical = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const port = Number(env.MLX_EMBED_PORT);
  if (
    platform !== "darwin" ||
    arch !== "arm64" ||
    config.embedMode !== "gpu" ||
    env.GMAX_GEMMA_PROFILE !== "1" ||
    !env.GMAX_HOME ||
    canonical(env.GMAX_HOME) === canonical(path.join(os.homedir(), ".gmax")) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    [8100, 8101, 8079].includes(port)
  )
    throw new Error(
      "Gemma requires Apple Silicon GPU, GMAX_GEMMA_PROFILE=1, a separate GMAX_HOME and a separate MLX_EMBED_PORT (for example 18100); keep the Small profile unchanged",
    );
}

/** Read only the selected profile; no model, store or client registration. */
export function isGemma2Profile(
  home = process.env.GMAX_HOME ?? path.join(os.homedir(), ".gmax"),
): boolean {
  if (process.env.GMAX_GEMMA_PROFILE === "1") return true;
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))
        .modelTier === "gemma2"
    );
  } catch {
    return false;
  }
}

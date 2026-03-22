import { Command } from "commander";
import { MODEL_TIERS } from "../config";
import {
  readGlobalConfig,
  readIndexConfig,
  writeGlobalConfig,
  writeSetupConfig,
} from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths } from "../lib/utils/project-root";

export const config = new Command("config")
  .description("View or update gmax configuration")
  .option(
    "--embed-mode <mode>",
    "Set embedding mode: cpu or gpu",
  )
  .option(
    "--model-tier <tier>",
    "Set model tier: small (384d) or standard (768d)",
  )
  .addHelpText(
    "after",
    `
Examples:
  gmax config                          Show current configuration
  gmax config --embed-mode cpu         Switch to CPU embeddings
  gmax config --model-tier standard    Switch to standard model (768d)
`,
  )
  .action(async (_opts, cmd) => {
    const options: {
      embedMode?: string;
      modelTier?: string;
    } = cmd.optsWithGlobals();

    const globalConfig = readGlobalConfig();
    const paths = ensureProjectPaths(process.cwd());
    const indexConfig = readIndexConfig(paths.configPath);

    const hasUpdates =
      options.embedMode !== undefined || options.modelTier !== undefined;

    if (!hasUpdates) {
      // Show current config
      const tier =
        MODEL_TIERS[globalConfig.modelTier] ?? MODEL_TIERS.small;
      console.log("gmax configuration (~/.gmax/config.json)\n");
      console.log(`  Model tier:  ${globalConfig.modelTier} (${tier.vectorDim}d, ${tier.params})`);
      console.log(`  Embed mode:  ${globalConfig.embedMode}`);
      console.log(
        `  Embed model: ${globalConfig.embedMode === "gpu" ? tier.mlxModel : tier.onnxModel}`,
      );
      if (indexConfig?.indexedAt) {
        console.log(`  Last indexed: ${indexConfig.indexedAt}`);
      }
      console.log(
        `\nTo change: gmax config --embed-mode <cpu|gpu> --model-tier <small|standard>`,
      );
      await gracefulExit();
      return;
    }

    // Validate inputs
    if (options.embedMode && !["cpu", "gpu"].includes(options.embedMode)) {
      console.error(`Invalid embed mode: ${options.embedMode} (use cpu or gpu)`);
      await gracefulExit(1);
      return;
    }
    if (options.modelTier && !MODEL_TIERS[options.modelTier]) {
      console.error(
        `Invalid model tier: ${options.modelTier} (use ${Object.keys(MODEL_TIERS).join(" or ")})`,
      );
      await gracefulExit(1);
      return;
    }

    const newTier = options.modelTier ?? globalConfig.modelTier;
    const newMode =
      (options.embedMode as "cpu" | "gpu") ?? globalConfig.embedMode;
    const tier = MODEL_TIERS[newTier] ?? MODEL_TIERS.small;

    const tierChanged = newTier !== globalConfig.modelTier;

    writeGlobalConfig({
      modelTier: newTier,
      vectorDim: tier.vectorDim,
      embedMode: newMode,
      mlxModel: newMode === "gpu" ? tier.mlxModel : undefined,
    });

    writeSetupConfig(paths.configPath, {
      embedMode: newMode,
      mlxModel: newMode === "gpu" ? tier.mlxModel : undefined,
      modelTier: newTier,
    });

    console.log(`Updated: embed-mode=${newMode}, model-tier=${newTier} (${tier.vectorDim}d)`);

    if (tierChanged) {
      console.log(
        "⚠️  Model tier changed — run `gmax index --reset` to rebuild with new dimensions.",
      );
    }

    await gracefulExit();
  });

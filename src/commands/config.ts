import { Command } from "commander";
import { MODEL_TIERS } from "../config";
import {
  embeddingFingerprintLabel,
  formatLegacyEmbeddingNotice,
  projectEmbeddingStatus,
} from "../lib/index/embedding-status";
import {
  readGlobalConfig,
  writeGlobalConfig,
  writeSetupConfig,
} from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { getProject } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

export const config = new Command("config")
  .description("View or update gmax configuration")
  .option("--embed-mode <mode>", "Set embedding mode: cpu or gpu")
  .option(
    "--model-tier <tier>",
    "Set model tier: small (384d) or standard (768d)",
  )
  .option(
    "--query-log <on|off>",
    "Enable/disable query logging to ~/.gmax/logs/queries.jsonl",
  )
  .addHelpText(
    "after",
    `
Examples:
  gmax config                          Show current configuration
  gmax config --embed-mode cpu         Switch to CPU embeddings
  gmax config --model-tier standard    Switch to standard model (768d)
  gmax config --query-log on           Enable query logging
`,
  )
  .action(async (_opts, cmd) => {
    const options: {
      embedMode?: string;
      modelTier?: string;
      queryLog?: string;
    } = cmd.optsWithGlobals();

    const globalConfig = readGlobalConfig();
    const paths = ensureProjectPaths(process.cwd());
    const project = getProject(findProjectRoot(process.cwd()) ?? process.cwd());

    const hasUpdates =
      options.embedMode !== undefined ||
      options.modelTier !== undefined ||
      options.queryLog !== undefined;

    if (!hasUpdates) {
      // Show current config
      const tier = MODEL_TIERS[globalConfig.modelTier] ?? MODEL_TIERS.small;
      console.log("gmax configuration (~/.gmax/config.json)\n");
      console.log(
        `  Model tier:  ${globalConfig.modelTier} (${tier.vectorDim}d, ${tier.params})`,
      );
      console.log(`  Embed mode:  ${globalConfig.embedMode}`);
      console.log(
        `  Embed model: ${globalConfig.embedMode === "gpu" ? tier.mlxModel : tier.onnxModel}`,
      );
      const identity = projectEmbeddingStatus(project, globalConfig);
      console.log(
        `  Configured:  ${identity.configured.tier} ${identity.configured.vectorDim}d [${embeddingFingerprintLabel(identity.configured.fingerprint)}]`,
      );
      if (identity.built) {
        const builtLabel =
          identity.state === "legacy" ? "Built (inferred):" : "Built:";
        console.log(
          `  ${builtLabel.padEnd(18)} ${identity.built.tier} ${identity.built.vectorDim}d [${embeddingFingerprintLabel(identity.built.fingerprint)}] (${identity.state})`,
        );
        if (identity.state === "legacy") {
          const notice = formatLegacyEmbeddingNotice(1);
          if (notice) console.log(`  ${notice}`);
        }
      }
      console.log(`  Query log:   ${globalConfig.queryLog ? "on" : "off"}`);
      if (project?.lastIndexed) {
        console.log(`  Last indexed: ${project.lastIndexed}`);
      }
      console.log(
        `\nTo change: gmax config --embed-mode <cpu|gpu> --model-tier <small|standard> --query-log <on|off>`,
      );
      await gracefulExit();
      return;
    }

    // Validate inputs
    if (options.embedMode && !["cpu", "gpu"].includes(options.embedMode)) {
      console.error(
        `Invalid embed mode: ${options.embedMode} (use cpu or gpu)`,
      );
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

    // Handle query-log toggle (independent of model/embed changes)
    if (options.queryLog !== undefined) {
      if (!["on", "off"].includes(options.queryLog)) {
        console.error(
          `Invalid query-log value: ${options.queryLog} (use on or off)`,
        );
        await gracefulExit(1);
        return;
      }
      const enabled = options.queryLog === "on";
      writeGlobalConfig({ ...globalConfig, queryLog: enabled });
      console.log(
        `Query logging ${enabled ? "enabled" : "disabled"}. Logs at ~/.gmax/logs/queries.jsonl`,
      );
      // If only query-log was changed, skip model updates
      if (!options.embedMode && !options.modelTier) {
        await gracefulExit();
        return;
      }
      // Reload config after queryLog write
      Object.assign(globalConfig, readGlobalConfig());
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
      queryLog: globalConfig.queryLog,
    });

    writeSetupConfig(paths.configPath, {
      embedMode: newMode,
      mlxModel: newMode === "gpu" ? tier.mlxModel : undefined,
      modelTier: newTier,
    });

    console.log(
      `Updated: embed-mode=${newMode}, model-tier=${newTier} (${tier.vectorDim}d)`,
    );

    if (tierChanged) {
      console.log(
        `Model tier changed (${globalConfig.vectorDim}d → ${tier.vectorDim}d). Existing indexes are preserved and search is blocked until you run 'gmax repair --rebuild'.`,
      );
    }

    await gracefulExit();
  });

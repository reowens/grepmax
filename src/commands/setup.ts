import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { MODEL_IDS, MODEL_TIERS, PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  readGlobalConfig,
  readIndexConfig,
  writeGlobalConfig,
  writeSetupConfig,
} from "../lib/index/index-config";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths } from "../lib/utils/project-root";

export const setup = new Command("setup")
  .description("Interactive setup: download models, choose embedding mode")
  .action(async () => {
    p.intro("gmax setup");

    // Step 1: Download ONNX models + grammars (existing behavior)
    try {
      await ensureSetup();
    } catch (error) {
      p.cancel("Setup failed");
      console.error(error);
      await gracefulExit(1);
    }

    // Download grammars
    const grammarSpinner = p.spinner();
    grammarSpinner.start("Checking Tree-sitter grammars...");
    await ensureGrammars(undefined, { silent: true });
    grammarSpinner.stop("Grammars ready");

    // Step 2: Show model status
    const modelIds = [MODEL_IDS.embed, MODEL_IDS.colbert];
    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(PATHS.models, ...id.split("/"));
      return { id, exists: fs.existsSync(modelPath) };
    });
    for (const { id, exists } of modelStatuses) {
      p.log.info(`${exists ? "✓" : "✗"} ${id}`);
    }

    // Check skiplist
    const colbertPath = path.join(
      PATHS.models,
      ...MODEL_IDS.colbert.split("/"),
    );
    const skiplistPath = path.join(colbertPath, "skiplist.json");
    if (!fs.existsSync(skiplistPath)) {
      try {
        const url = `https://huggingface.co/${MODEL_IDS.colbert}/resolve/main/skiplist.json`;
        const response = await fetch(url);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(skiplistPath, Buffer.from(buffer));
          p.log.success("Skiplist downloaded");
        }
      } catch {
        p.log.warn("Skiplist download failed (will use fallback)");
      }
    }

    // Step 3: Read existing config
    const paths = ensureProjectPaths(process.cwd());
    const existingConfig = readIndexConfig(paths.configPath);
    const globalConfig = readGlobalConfig();

    // Step 4: Model tier selection
    const modelTier = await p.select({
      message: "Model size",
      options: Object.values(MODEL_TIERS).map((tier) => ({
        value: tier.id,
        label: tier.label,
        hint: tier.id === "standard" ? "32GB+ RAM recommended" : "recommended",
      })),
      initialValue:
        existingConfig?.modelTier ?? globalConfig.modelTier ?? "small",
    });

    if (p.isCancel(modelTier)) {
      p.cancel("Setup cancelled");
      await gracefulExit();
      return;
    }

    const selectedTier = MODEL_TIERS[modelTier];

    // Step 5: Embed mode — auto-detect, no prompt needed
    const isAppleSilicon =
      process.arch === "arm64" && process.platform === "darwin";
    const embedMode: "cpu" | "gpu" =
      existingConfig?.embedMode ?? (isAppleSilicon ? "gpu" : "cpu");
    p.log.info(
      isAppleSilicon
        ? "Apple Silicon detected — using GPU acceleration (MLX)"
        : "Using CPU embeddings (ONNX)",
    );

    const mlxModel = embedMode === "gpu" ? selectedTier.mlxModel : undefined;

    // Step 6: Write configs
    writeSetupConfig(paths.configPath, {
      embedMode,
      mlxModel,
      modelTier,
    });
    writeGlobalConfig({
      modelTier,
      vectorDim: selectedTier.vectorDim,
      embedMode,
      mlxModel,
    });

    // Step 7: Warn about reindex if tier/mode changed
    if (existingConfig?.indexedAt) {
      const tierChanged = existingConfig.modelTier !== modelTier;
      const modeChanged = existingConfig.embedMode !== embedMode;
      if (tierChanged) {
        p.log.warn(
          `Model tier changed (${existingConfig.vectorDim ?? 384}d → ${selectedTier.vectorDim}d). Existing indexes will be rebuilt on next use.`,
        );
      } else if (modeChanged) {
        p.log.warn(
          "Embedding mode changed. Run `gmax serve` to apply the new settings.",
        );
      }
    }

    // Step 8: Install plugins for detected clients
    const installPlugins = await p.confirm({
      message: "Install plugins for detected clients?",
      initialValue: true,
    });

    if (!p.isCancel(installPlugins) && installPlugins) {
      const { plugin: pluginCmd } = await import("./plugin");
      await pluginCmd.parseAsync(["node", "gmax"]);
    }

    p.outro(
      `Ready — ${selectedTier.label}, ${embedMode === "gpu" ? "GPU" : "CPU"} mode`,
    );

    await gracefulExit();
  });

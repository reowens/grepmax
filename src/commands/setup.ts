import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { MODEL_IDS, PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { readIndexConfig, writeSetupConfig } from "../lib/index/index-config";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { ensureProjectPaths } from "../lib/utils/project-root";
import { gracefulExit } from "../lib/utils/exit";

const MLX_MODELS = [
  {
    value: "ibm-granite/granite-embedding-small-english-r2",
    label: "Granite Small (general purpose, 384-dim)",
  },
] as const;

export const setup = new Command("setup")
  .description("Interactive setup: download models, choose embedding mode")
  .action(async () => {
    p.intro("osgrep setup");

    // Step 1: Download ONNX models + grammars (existing behavior)
    try {
      await ensureSetup();
    } catch (error) {
      p.cancel("Setup failed");
      console.error(error);
      process.exit(1);
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
    modelStatuses.forEach(({ id, exists }) => {
      p.log.info(`${exists ? "✓" : "✗"} ${id}`);
    });

    // Check skiplist
    const colbertPath = path.join(PATHS.models, ...MODEL_IDS.colbert.split("/"));
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

    // Step 3: Interactive embed mode selection
    const paths = ensureProjectPaths(process.cwd());
    const existingConfig = readIndexConfig(paths.configPath);

    const embedMode = await p.select({
      message: "Embedding mode",
      options: [
        {
          value: "cpu" as const,
          label: "CPU only",
          hint: "ONNX — works everywhere",
        },
        {
          value: "gpu" as const,
          label: "GPU (MLX)",
          hint: "Apple Silicon only, faster indexing + search",
        },
      ],
      initialValue: existingConfig?.embedMode ?? "cpu",
    });

    if (p.isCancel(embedMode)) {
      p.cancel("Setup cancelled");
      await gracefulExit();
      return;
    }

    let mlxModel: string | undefined;
    if (embedMode === "gpu") {
      const modelChoice = await p.select({
        message: "MLX embedding model",
        options: MLX_MODELS.map((m) => ({
          value: m.value,
          label: m.label,
        })),
        initialValue: existingConfig?.mlxModel ?? MLX_MODELS[0].value,
      });

      if (p.isCancel(modelChoice)) {
        p.cancel("Setup cancelled");
        await gracefulExit();
        return;
      }
      mlxModel = modelChoice;
    }

    // Step 4: Write config
    writeSetupConfig(paths.configPath, { embedMode, mlxModel });

    // Step 5: Warn about reindex if mode/model changed
    if (
      existingConfig?.indexedAt &&
      (existingConfig.embedMode !== embedMode ||
        existingConfig.mlxModel !== mlxModel)
    ) {
      p.log.warn(
        "Embedding mode changed. Run `osgrep serve` to reindex with the new settings.",
      );
    }

    p.outro(
      embedMode === "gpu"
        ? `Ready — GPU mode with ${mlxModel}`
        : "Ready — CPU mode",
    );

    await gracefulExit();
  });

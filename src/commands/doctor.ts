import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { MODEL_IDS, MODEL_TIERS, PATHS } from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { findProjectRoot } from "../lib/utils/project-root";

export const doctor = new Command("doctor")
  .description("Check installation health, models, and index status")
  .action(async () => {
    console.log("🏥 gmax Doctor\n");

    const root = PATHS.globalRoot;
    const models = PATHS.models;
    const grammars = PATHS.grammars;
    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Grammars", grammars);

    const globalConfig = readGlobalConfig();
    const tier = MODEL_TIERS[globalConfig.modelTier] ?? MODEL_TIERS.small;
    const embedModel =
      globalConfig.embedMode === "gpu" ? tier.mlxModel : tier.onnxModel;

    console.log(
      `\nEmbed mode: ${globalConfig.embedMode} | Model tier: ${globalConfig.modelTier} (${tier.vectorDim}d)`,
    );
    console.log(`Embed model: ${embedModel}`);
    console.log(`ColBERT model: ${MODEL_IDS.colbert}`);

    const modelStatuses = [embedModel, MODEL_IDS.colbert].map((id) => {
      const modelPath = path.join(models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, exists }) => {
      const symbol = exists ? "✅" : "⚠️ ";
      console.log(`${symbol} ${id}: ${exists ? "downloaded" : "will download on first use"}`);
    });

    console.log(`\nLocal Project: ${process.cwd()}`);
    const projectRoot = findProjectRoot(process.cwd());
    if (projectRoot) {
      console.log(`✅ Project root: ${projectRoot}`);
      console.log(`   Centralized index at: ~/.gmax/lancedb/`);
    } else {
      console.log(
        `ℹ️  No index found in current directory (run 'gmax index' to create one)`,
      );
    }

    // Check MLX embed server
    const embedUp = await fetch("http://127.0.0.1:8100/health")
      .then((r) => r.ok)
      .catch(() => false);
    console.log(
      `${embedUp ? "✅" : "⚠️ "} MLX Embed: ${embedUp ? "running (port 8100)" : "not running"}`,
    );

    // Check summarizer server
    const summarizerUp = await fetch("http://127.0.0.1:8101/health")
      .then((r) => r.ok)
      .catch(() => false);
    console.log(
      `${summarizerUp ? "✅" : "⚠️ "} Summarizer: ${summarizerUp ? "running (port 8101)" : "not running"}`,
    );

    // Check summary coverage
    try {
      const { VectorDB } = await import("../lib/store/vector-db");
      const db = new VectorDB(PATHS.lancedbDir);
      const table = await db.ensureTable();
      const totalChunks = await table.countRows();
      if (totalChunks > 0) {
        const withSummary = (
          await table
            .query()
            .where("length(summary) > 5")
            .select(["id"])
            .toArray()
        ).length;
        const pct = Math.round((withSummary / totalChunks) * 100);
        const symbol = pct >= 90 ? "✅" : pct > 0 ? "⚠️ " : "❌";
        console.log(
          `${symbol} Summary coverage: ${withSummary}/${totalChunks} (${pct}%)`,
        );
      } else {
        console.log("ℹ️  No indexed chunks yet");
      }
      await db.close();
    } catch {
      console.log("⚠️  Could not check summary coverage");
    }

    console.log(
      `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
    );
    console.log("\nIf you see ✅ everywhere, you are ready to search!");

    await gracefulExit();
  });

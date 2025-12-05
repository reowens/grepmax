import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { MODEL_IDS, PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { gracefulExit } from "../lib/utils/exit";

export const setup = new Command("setup")
  .description("One-time setup: download models and prepare osgrep")
  .action(async () => {
    console.log("osgrep Setup\n");

    try {
      await ensureSetup();
    } catch (error) {
      console.error("Setup failed:", error);
      process.exit(1);
    }

    // Show final status
    console.log("\nSetup Complete!\n");

    const modelIds = [MODEL_IDS.embed, MODEL_IDS.colbert];

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Global Root", PATHS.globalRoot);
    checkDir("Models", PATHS.models);
    checkDir("Grammars", PATHS.grammars);

    // Download Grammars
    console.log("\nChecking Tree-sitter Grammars...");
    await ensureGrammars();

    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(PATHS.models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, exists }) => {
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} Model: ${id}`);
    });

    // Write skiplist.json
    console.log("\nGenerating skiplist.json...");
    const skiplistTokens = [
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 27, 28, 29, 30, 31,
      32, 33, 60, 61, 62, 63, 64, 65, 92, 93, 94, 95,
    ];
    const colbertPath = path.join(PATHS.models, ...MODEL_IDS.colbert.split("/"));
    if (fs.existsSync(colbertPath)) {
      fs.writeFileSync(
        path.join(colbertPath, "skiplist.json"),
        JSON.stringify(skiplistTokens),
      );
      console.log(`✓ Wrote ${skiplistTokens.length} skip IDs to skiplist.json`);
    } else {
      console.warn("⚠ ColBERT model directory not found, skipping skiplist generation.");
    }

    console.log(`\nosgrep is ready! You can now run:`);
    console.log(`   osgrep index              # Index your repository`);
    console.log(`   osgrep "search query"     # Search your code`);
    console.log(`   osgrep doctor             # Check health status`);

    await gracefulExit();
  });

import { Command } from "commander";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { downloadModels } from "../lib/model-loader";
import ora from "ora";

export const setup = new Command("setup")
  .description("One-time setup: download models and prepare osgrep")
  .action(async () => {
    console.log("osgrep Setup\n");
    console.log("This will download models (~150MB) and prepare your system.\n");

    const home = os.homedir();
    const root = path.join(home, ".osgrep");
    const models = path.join(root, "models");
    const data = path.join(root, "data");
    const grammars = path.join(root, "grammars");

    // Create directories if they don't exist
    let spinner = ora("Creating directories...").start();
    try {
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
      if (!fs.existsSync(models)) fs.mkdirSync(models, { recursive: true });
      if (!fs.existsSync(data)) fs.mkdirSync(data, { recursive: true });
      if (!fs.existsSync(grammars)) fs.mkdirSync(grammars, { recursive: true });
      spinner.succeed("Directories created");
    } catch (error) {
      spinner.fail("Failed to create directories");
      console.error(error);
      process.exit(1);
    }

    // Download models using standalone function
    spinner = ora("Downloading models (this may take a few minutes)...").start();
    
    try {
      await downloadModels();
      spinner.succeed("Models downloaded and ready");
    } catch (error) {
      spinner.fail("Failed to download models");
      console.error(error);
      process.exit(1);
    }

    // Small delay to ensure spinner output is flushed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Show final status
    console.log("\nSetup Complete!\n");

    const modelIds = [
      "mixedbread-ai/mxbai-embed-xsmall-v1",
      "mixedbread-ai/mxbai-rerank-xsmall-v1",
    ];

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Data (Vector DB)", data);
    checkDir("Grammars", grammars);

    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, exists }) => {
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} Model: ${id}`);
    });

    console.log(`\nosgrep is ready! You can now run:`);
    console.log(`   osgrep index              # Index your repository`);
    console.log(`   osgrep "search query"     # Search your code`);
    console.log(`   osgrep doctor             # Check health status`);

    // Allow time for transformers.js cleanup before exit
    await new Promise(resolve => setTimeout(resolve, 500));
    process.exit(0);
  });


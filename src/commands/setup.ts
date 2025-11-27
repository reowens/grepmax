import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { ensureSetup } from "../lib/setup-helpers";
import { MODEL_IDS } from "../config";
import { gracefulExit } from "../lib/exit";


export const setup = new Command("setup")
  .description("One-time setup: download models and prepare osgrep")
  .action(async () => {
    console.log("osgrep Setup\n");


    const home = os.homedir();
    const root = path.join(home, ".osgrep");
    const models = path.join(root, "models");
    const data = path.join(root, "data");
    const grammars = path.join(root, "grammars");

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

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Data (Vector DB)", data);
    checkDir("Data (Vector DB)", data);
    checkDir("Grammars", grammars);

    // Download Grammars
    console.log("\nChecking Tree-sitter Grammars...");
    if (!fs.existsSync(grammars)) {
      fs.mkdirSync(grammars, { recursive: true });
    }

    const GRAMMAR_URLS: Record<string, string> = {
      typescript:
        "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm",
      tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm",
      python:
        "https://github.com/tree-sitter/tree-sitter-python/releases/latest/download/tree-sitter-python.wasm",
      go:
        "https://github.com/tree-sitter/tree-sitter-go/releases/latest/download/tree-sitter-go.wasm",
    };

    const downloadFile = async (url: string, dest: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download ${url}`);
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(dest, Buffer.from(arrayBuffer));
    };

    for (const [lang, url] of Object.entries(GRAMMAR_URLS)) {
      const dest = path.join(grammars, `tree-sitter-${lang}.wasm`);
      if (fs.existsSync(dest)) {
        console.log(`✓ Grammar: ${lang}`);
      } else {
        process.stdout.write(`⬇ Downloading ${lang} grammar... `);
        try {
          await downloadFile(url, dest);
          console.log("Done");
        } catch (err) {
          console.log("Failed");
          console.error(`  Error downloading ${lang}:`, err);
        }
      }
    }

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



    await gracefulExit();
  });

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { MODEL_IDS, PATHS } from "../config";
import { gracefulExit } from "../lib/utils/exit";
import { findProjectRoot } from "../lib/utils/project-root";

export const doctor = new Command("doctor")
  .description("Check gmax health and paths")
  .action(async () => {
    console.log("🏥 gmax Doctor\n");

    const root = PATHS.globalRoot;
    const models = PATHS.models;
    const grammars = PATHS.grammars;
    const modelIds = [MODEL_IDS.embed, MODEL_IDS.colbert];

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Models", models);
    checkDir("Grammars", grammars);

    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, path: p, exists }) => {
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} Model: ${id} (${p})`);
    });

    const missingModels = modelStatuses.filter(({ exists }) => !exists);
    if (missingModels.length > 0) {
      console.log(
        "❌ Some models are missing; gmax will try bundled copies first, then download.",
      );
    }

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

    console.log(
      `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
    );
    console.log("\nIf you see ✅ everywhere, you are ready to search!");

    await gracefulExit();
  });

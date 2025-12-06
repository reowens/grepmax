import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const PLUGIN_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugin",
  "osgrep.ts",
);

// The plugin code
const PLUGIN_CONTENT = `import { type Plugin, tool } from "@opencode-ai/plugin";

export const OsgrepPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      osgrep_search: tool({
        description:
          "Semantic search for code. Use this to find relevant files and functions by concept (e.g. 'auth logic', 'database connection'). Returns code snippets with roles (ORCHESTRATION vs DEFINITION). NOTE: If the repository is not indexed, this tool will automatically index it, which may take a minute.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "The search query (e.g. 'how is request validation handled?')",
            ),
        },
        async execute({ query }) {
          try {
            // Run osgrep with --json flag
            // Note: We assume 'osgrep' is in the PATH.
            const { stdout } = await $\`osgrep search \${query} --json\`;
            return stdout.trim();
          } catch (e: any) {
            return \`Error running osgrep: \${e.message}\`;
          }
        },
      }),
      osgrep_trace: tool({
        description:
          "Trace the call graph of a function or symbol. Use this to see who calls a function (callers) and what it calls (callees). Useful for impact analysis.",
        args: {
          symbol: tool.schema
            .string()
            .describe(
              "The exact symbol name to trace (e.g. 'validateUser')",
            ),
        },
        async execute({ symbol }) {
          try {
            const { stdout } = await $\`osgrep search --trace \${symbol} --json\`;
            return stdout.trim();
          } catch (e: any) {
            return \`Error running osgrep trace: \${e.message}\`;
          }
        },
      }),
    },
  };
};
`;

export const installOpencode = new Command("install-opencode")
  .description("Install the osgrep plugin for OpenCode")
  .action(async () => {
    try {
      const dir = path.dirname(PLUGIN_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PLUGIN_PATH, PLUGIN_CONTENT);
      console.log(`✅ Successfully installed osgrep plugin to ${PLUGIN_PATH}`);
      console.log("Restart OpenCode to apply changes.");
    } catch (e: any) {
      console.error(`❌ Failed to install plugin: ${e.message}`);
      process.exit(1);
    }
  });

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Uninstall the osgrep plugin from OpenCode")
  .action(async () => {
    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        fs.unlinkSync(PLUGIN_PATH);
        console.log(
          `✅ Successfully removed osgrep plugin from ${PLUGIN_PATH}`,
        );
      } else {
        console.log("Plugin not found.");
      }
    } catch (e: any) {
      console.error(`❌ Failed to uninstall plugin: ${e.message}`);
      process.exit(1);
    }
  });

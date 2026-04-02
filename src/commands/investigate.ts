import * as path from "node:path";
import { Command } from "commander";
import { gracefulExit } from "../lib/utils/exit";
import { findProjectRoot } from "../lib/utils/project-root";

export const investigateCmd = new Command("investigate")
  .description(
    "Ask a question about the codebase using local LLM + gmax tools",
  )
  .argument("<question>", "Natural language question about the codebase")
  .option("--root <dir>", "Project root directory")
  .option("--rounds <n>", "Max tool-call rounds (default 10)", "10")
  .option("-v, --verbose", "Print tool calls and results to stderr", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax investigate "how does the search command work?"
  gmax investigate "what would break if I changed VectorDB?" -v
  gmax investigate "where is authentication handled?" --root ~/project
`,
  )
  .action(async (question, opts) => {
    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const maxRounds = Math.min(
        Math.max(Number.parseInt(opts.rounds || "10", 10), 1),
        20,
      );

      // Ensure LLM server is running
      const { ensureDaemonRunning, sendDaemonCommand } = await import(
        "../lib/utils/daemon-client"
      );
      if (!(await ensureDaemonRunning())) {
        console.error("Failed to start daemon");
        process.exitCode = 1;
        return;
      }
      const llmResp = await sendDaemonCommand(
        { cmd: "llm-start" },
        { timeoutMs: 90_000 },
      );
      if (!llmResp.ok) {
        console.error(`LLM server error: ${llmResp.error}`);
        console.error("Run `gmax llm on` to enable the LLM server.");
        process.exitCode = 1;
        return;
      }

      const { investigate } = await import("../lib/llm/investigate");
      const result = await investigate({
        question,
        projectRoot,
        maxRounds,
        verbose: opts.verbose,
      });

      console.log(result.answer);

      if (opts.verbose) {
        process.stderr.write("\n--- metrics ---\n");
        process.stderr.write(`rounds:     ${result.rounds}\n`);
        process.stderr.write(`tool calls: ${result.toolCalls}\n`);
        process.stderr.write(
          `wall time:  ${(result.wallMs / 1000).toFixed(1)}s\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Investigate failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });

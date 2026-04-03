import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { gracefulExit } from "../lib/utils/exit";
import { findProjectRoot } from "../lib/utils/project-root";

export const review = new Command("review")
  .description("Review code changes using local LLM + codebase context")
  .option("--commit <ref>", "Commit to review", "HEAD")
  .option("--root <dir>", "Project root directory")
  .option("--background", "Run review asynchronously via daemon", false)
  .option("-v, --verbose", "Print progress to stderr", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax review                           Review HEAD
  gmax review --commit abc1234          Review specific commit
  gmax review --background              Run async via daemon

Subcommands:
  gmax review report [--json]           Show accumulated findings
  gmax review clear                     Clear report
  gmax review install [DIR]             Install post-commit hook
`,
  )
  .action(async (opts) => {
    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const commitRef = opts.commit;

      if (opts.background) {
        // Fire-and-forget via daemon
        const { ensureDaemonRunning, sendDaemonCommand } = await import(
          "../lib/utils/daemon-client"
        );
        if (!(await ensureDaemonRunning())) {
          console.error("Failed to start daemon");
          process.exitCode = 1;
          return;
        }
        const resp = await sendDaemonCommand(
          { cmd: "review", root: projectRoot, commitRef },
          { timeoutMs: 5_000 },
        );
        if (!resp.ok) {
          console.error(`Review failed: ${resp.error}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Review queued for ${commitRef}`);
        return;
      }

      // Foreground: ensure LLM server is running
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

      const { reviewCommit } = await import("../lib/llm/review");
      const result = await reviewCommit({
        commitRef,
        projectRoot,
        verbose: opts.verbose,
      });

      if (result.clean) {
        console.log(`${result.commit} — clean (${result.duration}s)`);
      } else {
        console.log(
          `${result.commit} — ${result.findingCount} finding(s) (${result.duration}s)`,
        );
        console.log("Run `gmax review report` to see details.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Review failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });

// --- Subcommands ---

review
  .command("report")
  .description("Show accumulated review findings")
  .option("--json", "Output raw JSON", false)
  .option("--root <dir>", "Project root directory")
  .action(async (opts) => {
    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;

      const { readReport, formatReportText } = await import(
        "../lib/llm/report"
      );
      const report = readReport(projectRoot);

      if (!report || report.reviews.length === 0) {
        console.log("No review findings yet.");
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatReportText(report));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Report failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });

review
  .command("clear")
  .description("Clear the review report")
  .option("--root <dir>", "Project root directory")
  .action(async (opts) => {
    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;

      const { clearReport } = await import("../lib/llm/report");
      clearReport(projectRoot);
      console.log("Report cleared.");
    } finally {
      await gracefulExit();
    }
  });

review
  .command("install [dir]")
  .description("Install post-commit hook for automatic review")
  .action(async (dir) => {
    try {
      let targetDir: string;
      if (dir) {
        targetDir = path.resolve(dir);
      } else {
        try {
          targetDir = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf-8",
          }).trim();
        } catch {
          console.error("Not in a git repo and no directory specified.");
          process.exitCode = 1;
          return;
        }
      }

      const hooksDir = path.join(targetDir, ".git", "hooks");
      if (!fs.existsSync(hooksDir)) {
        console.error(`Not a git repo: ${targetDir}`);
        process.exitCode = 1;
        return;
      }

      const hookFile = path.join(hooksDir, "post-commit");

      // Backup existing hook if it doesn't mention gmax
      if (fs.existsSync(hookFile)) {
        const existing = fs.readFileSync(hookFile, "utf-8");
        if (!existing.includes("gmax review")) {
          fs.copyFileSync(hookFile, `${hookFile}.gmax-backup`);
          console.log("Backed up existing post-commit hook.");
        }
      }

      // Resolve gmax binary path
      let gmaxBin = "gmax";
      try {
        gmaxBin = execFileSync("which", ["gmax"], { encoding: "utf-8" }).trim();
      } catch {}

      const hookContent = `#!/usr/bin/env bash
# gmax review — async code review on commit
# Always exits 0 to never block git
"${gmaxBin}" review --commit HEAD --background --root "${targetDir}" || true
`;

      fs.writeFileSync(hookFile, hookContent, { mode: 0o755 });
      console.log(`Installed post-commit hook in ${targetDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Install failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });

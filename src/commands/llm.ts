import * as path from "node:path";
import { Command } from "commander";
import { gracefulExit } from "../lib/utils/exit";

async function showStatus() {
  const { isDaemonRunning, sendDaemonCommand } = await import("../lib/utils/daemon-client");
  if (!(await isDaemonRunning())) {
    console.log("LLM server: not running (daemon not started)");
    return;
  }
  const resp = await sendDaemonCommand({ cmd: "llm-status" });
  if (!resp.ok) {
    console.error("Failed to get LLM status:", resp.error);
    process.exitCode = 1;
    return;
  }
  if (resp.running) {
    const model = path.basename(String(resp.model));
    const uptime = Number(resp.uptime) || 0;
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    console.log(`LLM server: running (PID: ${resp.pid}, port: ${resp.port})`);
    console.log(`  Model: ${model}`);
    console.log(`  Uptime: ${mins}m ${secs}s`);
  } else {
    console.log("LLM server: not running");
  }
}

export const llm = new Command("llm")
  .description("Manage the local LLM server (llama-server)")
  .action(async () => {
    try {
      await showStatus();
    } finally {
      await gracefulExit();
    }
  });

llm
  .command("start")
  .description("Start the LLM server")
  .action(async () => {
    try {
      const { ensureDaemonRunning, sendDaemonCommand } = await import("../lib/utils/daemon-client");
      if (!(await ensureDaemonRunning())) {
        console.error("Failed to start daemon");
        process.exitCode = 1;
        return;
      }
      console.log("Starting LLM server...");
      const resp = await sendDaemonCommand(
        { cmd: "llm-start" },
        { timeoutMs: 90_000 },
      );
      if (!resp.ok) {
        console.error(`Failed: ${resp.error}`);
        process.exitCode = 1;
        return;
      }
      const model = path.basename(String(resp.model));
      console.log(`LLM server ready (PID: ${resp.pid}, port: ${resp.port}, model: ${model})`);
    } finally {
      await gracefulExit();
    }
  });

llm
  .command("stop")
  .description("Stop the LLM server")
  .action(async () => {
    try {
      const { isDaemonRunning, sendDaemonCommand } = await import("../lib/utils/daemon-client");
      if (!(await isDaemonRunning())) {
        console.log("Daemon not running");
        return;
      }
      const resp = await sendDaemonCommand({ cmd: "llm-stop" });
      if (!resp.ok) {
        console.error(`Failed: ${resp.error}`);
        process.exitCode = 1;
        return;
      }
      console.log("LLM server stopped");
    } finally {
      await gracefulExit();
    }
  });

llm
  .command("status")
  .description("Show LLM server status")
  .action(async () => {
    try {
      await showStatus();
    } finally {
      await gracefulExit();
    }
  });

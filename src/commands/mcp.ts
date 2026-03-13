import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { findProjectRoot } from "../lib/utils/project-root";
import {
  getServerForProject,
  isProcessRunning,
} from "../lib/utils/server-registry";

export const mcp = new Command("mcp")
  .description("Start MCP server for osgrep")
  .action(async (_optsArg, _cmd) => {
    process.on("SIGINT", () => {
      console.error("Received SIGINT, shutting down gracefully...");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.error("Received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });

    // Prevent unhandled promise rejections from crashing the MCP server
    process.on("unhandledRejection", (reason, promise) => {
      console.error(
        "[ERROR] Unhandled Rejection at:",
        promise,
        "reason:",
        reason,
      );
    });

    // The MCP server is writing to stdout, so all logs are written to stderr
    console.log = (...args: unknown[]) => {
      process.stderr.write(`[LOG] ${args.join(" ")}\n`);
    };

    console.error = (...args: unknown[]) => {
      process.stderr.write(`[ERROR] ${args.join(" ")}\n`);
    };

    console.debug = (..._args: unknown[]) => {
      // process.stderr.write(`[DEBUG] ${args.join(" ")}\n`);
    };

    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "osgrep",
        version: JSON.parse(
          fs.readFileSync(path.join(__dirname, "../../package.json"), {
            encoding: "utf-8",
          }),
        ).version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (_request) => {
      return {
        content: [{ type: "text", text: "Not implemented" }],
        isError: true,
      };
    });

    await server.connect(transport);

    // Ensure the serve daemon is running (handles indexing, GPU, live reindex).
    // The search CLI checks for a running daemon and uses it for GPU-accelerated search.
    setTimeout(() => {
      try {
        const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
        const existing = getServerForProject(projectRoot);

        if (existing && isProcessRunning(existing.pid)) {
          console.log(
            `[MCP] Serve daemon already running (PID: ${existing.pid}, Port: ${existing.port})`,
          );
          return;
        }

        console.log("[MCP] Starting serve daemon...");
        const child = spawn("osgrep", ["serve", "-b"], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        console.log(`[MCP] Serve daemon started (PID: ${child.pid})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[MCP] Failed to start serve daemon:", msg);
      }
    }, 1000);
  });

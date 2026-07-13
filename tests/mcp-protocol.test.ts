import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: any;
  error?: any;
};

function waitForMessage(
  messages: JsonRpcMessage[],
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 10_000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("Timed out waiting for MCP message"));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function send(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe("MCP protocol", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (!child.killed) child.kill("SIGTERM");
    }
  });

  it("advertises surprising_connections over tools/list", async () => {
    const root = process.cwd();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-mcp-protocol-"));
    const child = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "index.ts"), "mcp"],
      {
        cwd,
        env: {
          ...process.env,
          GMAX_NO_STALE_HINT: "1",
        },
      },
    );
    children.push(child);

    const messages: JsonRpcMessage[] = [];
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) messages.push(JSON.parse(line));
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gmax-vitest", version: "0" },
      },
    });
    const initialized = await waitForMessage(
      messages,
      (message) => message.id === 1,
    );
    expect(initialized.error, stderr).toBeUndefined();

    send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const listed = await waitForMessage(
      messages,
      (message) => message.id === 2,
    );
    expect(listed.error, stderr).toBeUndefined();
    const tools = listed.result?.tools ?? [];
    const tool = tools.find(
      (entry: any) => entry.name === "surprising_connections",
    );

    expect(tool).toBeDefined();
    expect(tool.description).toContain("Experimental orientation signal");
    expect(tool.inputSchema.required).toContain("experimental");
    expect(tool.inputSchema.properties.experimental.type).toBe("boolean");
    expect(tool.inputSchema.properties.in.type).toBe("string");
    expect(tool.inputSchema.properties.exclude.type).toBe("string");

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "surprising_connections",
        arguments: {
          experimental: true,
          root: cwd,
          sample: 1,
          neighbors: 1,
          top: 1,
        },
      },
    });

    const called = await waitForMessage(
      messages,
      (message) => message.id === 3,
    );
    expect(called.error, stderr).toBeUndefined();
    const text = called.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Unknown registered project");
  }, 15_000);
});

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

it.each(["legacy", "modern"])(
  "MCP stays pipe-only while routing concurrent roots, symlinks and offline stores (%s)",
  async (era) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-mcp-stores-"));
    const primary = path.join(dir, ".gmax");
    const secondary = path.join(dir, "secondary-store");
    const roots = [
      path.join(dir, "primary-project"),
      path.join(dir, "external-project"),
    ];
    const alias = path.join(dir, "external-alias");
    const offline = `/Volumes/gmax-missing-${process.pid}/project`;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      for (const [i, home] of [primary, secondary].entries()) {
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(roots[i]);
        const config = { modelTier: "small", vectorDim: 384, embedMode: "cpu" };
        fs.writeFileSync(
          path.join(home, "config.json"),
          JSON.stringify(config),
        );
        fs.writeFileSync(
          path.join(home, "projects.json"),
          JSON.stringify([
            {
              ...config,
              root: roots[i],
              name: i ? "external" : "primary",
              lastIndexed: new Date().toISOString(),
              chunkCount: 1,
              status: "indexed",
            },
          ]),
        );
        const db = new VectorDB(path.join(home, "lancedb"), 384);
        try {
          await db.insertBatch([
            {
              ...(db as any).seedRow(),
              id: `fixture-${i}`,
              path: path.join(
                roots[i],
                i ? "external-fixture.ts" : "primary-fixture.ts",
              ),
              content: `fixture-${i}`,
              defined_symbols: ["Fixture"],
              start_line: 1,
              end_line: 2,
            },
          ]);
        } finally {
          await db.close();
        }
      }
      fs.symlinkSync(roots[1], alias);
      fs.writeFileSync(
        path.join(primary, "stores.json"),
        JSON.stringify({
          stores: [
            { prefix: roots[1], home: secondary },
            {
              prefix: path.dirname(offline),
              home: path.join(path.dirname(offline), "store"),
            },
          ],
        }),
      );
      const listenMarker = path.join(dir, "unexpected-listener");
      const listenGuard = path.join(dir, "no-listeners.cjs");
      fs.writeFileSync(
        listenGuard,
        `const fs = require("node:fs");
       require("node:net").Server.prototype.listen = function () {
         fs.writeFileSync(${JSON.stringify(listenMarker)}, "MCP attempted a server listener");
         throw new Error("MCP must communicate over pipes only");
       };`,
      );
      child = spawn(
        process.execPath,
        [
          "--import",
          path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
          path.join(process.cwd(), "src/bin.ts"),
          "mcp",
        ],
        {
          cwd: roots[0],
          env: {
            ...process.env,
            HOME: dir,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(listenGuard)}`,
            GMAX_HOME: primary,
            GMAX_NO_AUTOSTART: "1",
            GMAX_NO_STALE_HINT: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let buffer = "",
        stderr = "",
        nextId = 1;
      const pending = new Map<
        number,
        { resolve(value: any): void; reject(error: Error): void }
      >();
      child.stdout!.on("data", (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const n = buffer.indexOf("\n");
          if (n < 0) break;
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          if (!line.trim()) continue;
          const response = JSON.parse(line);
          pending.get(response.id)?.resolve(response);
          pending.delete(response.id);
        }
      });
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const request = (method: string, params: unknown): Promise<any> =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP request timeout: ${stderr}`));
          }, 15_000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject,
          });
          const wireParams =
            era === "modern"
              ? {
                  ...(params as Record<string, unknown>),
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": {
                      name: "fixture",
                      version: "1",
                    },
                  },
                }
              : params;
          child!.stdin!.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params: wireParams })}\n`,
          );
        });
      const initialized = await request(
        era === "modern" ? "server/discover" : "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      );
      expect(initialized.error, stderr).toBeUndefined();
      if (era === "legacy")
        child.stdin!.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
      const call = (root: string) =>
        request("tools/call", {
          name: "peek_symbol",
          arguments: { symbol: "Fixture", root },
        });
      const results = await Promise.all([
        call(roots[0]),
        call(alias),
        call("external"),
      ]);
      for (const response of results)
        expect(
          response.result?.isError,
          stderr + JSON.stringify(response),
        ).not.toBe(true);
      expect(results[0].result.content[0].text).toContain("primary-fixture.ts");
      expect(results[1].result.content[0].text).toContain(
        "external-fixture.ts",
      );
      expect(results[2].result.content[0].text).toContain(
        "external-fixture.ts",
      );
      const absent = await call(offline);
      expect(absent.result.isError).toBe(true);
      expect(absent.result.content[0].text).toContain("not mounted");
      const listed = await request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      expect(listed.result.content[0].text).toContain(roots[1]);
      expect(listed.result.content[0].text).toContain("offline");
      const status = await request("tools/call", {
        name: "index_status",
        arguments: { root: roots[1] },
      });
      expect(status.result.isError, JSON.stringify(status)).not.toBe(true);
      if (era === "modern") expect(status.result.resultType).toBe("complete");
      expect(status.result.content[0].text).toContain(secondary);
      expect(status.result.structuredContent).toMatchObject({
        root: roots[1],
        store: path.join(secondary, "lancedb"),
        secondary: true,
        chunks: 1,
        files: 1,
        watcher: { status: "unobserved", indexState: null },
        compaction: null,
      });
      const structuredGraphs = await Promise.all(
        [roots[0], alias].map((root) =>
          request("tools/call", {
            name: "trace_calls",
            arguments: { symbol: "Fixture", root },
          }),
        ),
      );
      for (const [i, response] of structuredGraphs.entries()) {
        expect(response.error, stderr).toBeUndefined();
        expect(response.result.isError, JSON.stringify(response)).not.toBe(
          true,
        );
        expect(response.result.structuredContent).toMatchObject({
          root: roots[i],
          found: true,
          center: {
            location: {
              path: path.join(
                roots[i],
                i ? "external-fixture.ts" : "primary-fixture.ts",
              ),
              line: 2,
            },
          },
          approximate: true,
        });
      }
      const dead = await request("tools/call", {
        name: "dead",
        arguments: { symbol: "Fixture", root: "external" },
      });
      expect(dead.error, stderr).toBeUndefined();
      expect(dead.result.structuredContent).toMatchObject({
        root: roots[1],
        status: "dead",
        definition: { line: 2 },
        approximate: true,
      });
      const missing = await request("tools/call", {
        name: "dead",
        arguments: { symbol: "Missing", root: "external" },
      });
      expect(missing.error, stderr).toBeUndefined();
      expect(missing.result.structuredContent).toMatchObject({
        status: "not_found",
        definition: null,
      });

      // Offline inventory must remain visible even when no mounted store has projects.
      fs.writeFileSync(path.join(primary, "projects.json"), "[]");
      fs.writeFileSync(path.join(secondary, "projects.json"), "[]");
      const empty = await request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      expect(empty.result.content[0].text).toContain("offline");
      expect(empty.result.content[0].text).toContain("0 indexed project(s)");
      expect(fs.existsSync(listenMarker)).toBe(false);
      expect(fs.existsSync(path.join(secondary, "daemon.pid"))).toBe(false);
      const readers = path.join(secondary, "lancedb.lease", "readers");
      expect(
        fs.existsSync(readers) ? fs.readdirSync(readers) : [],
      ).toHaveLength(0);
    } finally {
      if (child) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child!.exitCode !== null) resolve();
          else child!.once("exit", () => resolve());
        });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  45_000,
);

import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (useColors ? `\x1b[32m${s}\x1b[39m` : s),
  blue: (s: string) => (useColors ? `\x1b[34m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
};

const MAX_CALLERS = 5;
const MAX_CALLEES = 8;

function extractSignature(
  filePath: string,
  startLine: number,
  endLine: number,
): { signature: string; bodyLines: number } {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const chunk = lines.slice(startLine, endLine + 1);
    const bodyLines = chunk.length;

    // Find the signature: everything up to and including the opening brace
    const sigLines: string[] = [];
    for (const line of chunk) {
      sigLines.push(line);
      if (line.includes("{") || line.includes("=>")) break;
    }

    // If we only got one line and it's the whole function, collapse it
    if (sigLines.length >= bodyLines) {
      return { signature: chunk.join("\n"), bodyLines: 0 };
    }

    const sig = sigLines.join("\n");
    const remaining = bodyLines - sigLines.length;
    return {
      signature: `${sig}\n    // ... (${remaining} lines)\n  }`,
      bodyLines,
    };
  } catch {
    return { signature: "(source not available)", bodyLines: 0 };
  }
}

export const peek = new Command("peek")
  .description("Compact symbol overview: signature + callers + callees")
  .argument("<symbol>", "The symbol to peek at")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (symbol, opts) => {
    let vectorDb: VectorDB | null = null;
    const root = opts.root ? path.resolve(opts.root) : process.cwd();
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const graphBuilder = new GraphBuilder(vectorDb, projectRoot);
      const graph = await graphBuilder.buildGraph(symbol);

      if (!graph.center) {
        const lines = [
          `Symbol not found: ${opts.agent ? symbol : style.bold(symbol)}`,
        ];
        if (!opts.agent) {
          lines.push(
            "",
            style.dim("Possible reasons:"),
            style.dim(
              "  \u2022 The symbol doesn't exist in any indexed project",
            ),
            style.dim(
              "  \u2022 The containing file hasn't been indexed yet",
            ),
            style.dim(
              "  \u2022 The name is spelled differently in the source",
            ),
            "",
            style.dim("Try:"),
            style.dim(
              "  gmax status          \u2014 see which projects are indexed",
            ),
            style.dim(
              "  gmax search <name>   \u2014 fuzzy search for similar symbols",
            ),
          );
        }
        console.log(lines.join("\n"));
        process.exitCode = 1;
        return;
      }

      const center = graph.center;
      const rel = (p: string) =>
        p.startsWith(projectRoot)
          ? p.slice(projectRoot.length + 1)
          : p;

      // Get chunk metadata for is_exported and end_line
      const table = await vectorDb.ensureTable();
      const prefix = projectRoot.endsWith("/")
        ? projectRoot
        : `${projectRoot}/`;
      const metaRows = await table
        .query()
        .select(["is_exported", "start_line", "end_line"])
        .where(
          `array_contains(defined_symbols, '${escapeSqlString(symbol)}') AND path LIKE '${escapeSqlString(prefix)}%'`,
        )
        .limit(1)
        .toArray();
      const exported = metaRows.length > 0 && Boolean((metaRows[0] as any).is_exported);
      const startLine = metaRows.length > 0 ? Number((metaRows[0] as any).start_line || 0) : center.line;
      const endLine = metaRows.length > 0 ? Number((metaRows[0] as any).end_line || 0) : center.line;

      // Get multi-hop callers if depth > 1
      let callerList: Array<{ symbol: string; file: string; line: number }>;
      if (depth > 1) {
        const multiHop = await graphBuilder.buildGraphMultiHop(symbol, depth);
        // Flatten caller tree
        const flat: Array<{ symbol: string; file: string; line: number }> = [];
        function walkCallers(tree: any[]) {
          for (const t of tree) {
            flat.push({ symbol: t.node.symbol, file: t.node.file, line: t.node.line });
            walkCallers(t.callers);
          }
        }
        walkCallers(multiHop.callerTree);
        callerList = flat;
      } else {
        callerList = graph.callers.map((c) => ({
          symbol: c.symbol,
          file: c.file,
          line: c.line,
        }));
      }

      const calleeList = graph.callees.map((c) => ({
        symbol: c.symbol,
        file: c.file,
        line: c.line,
      }));

      if (opts.agent) {
        // Compact TSV output
        const exportedStr = exported ? "exported" : "";
        console.log(
          `${center.symbol}\t${rel(center.file)}:${center.line + 1}\t${center.role}\t${exportedStr}`,
        );
        // Signature (first line only)
        const { signature } = extractSignature(center.file, startLine, endLine);
        const firstLine = signature.split("\n")[0].trim();
        console.log(`sig: ${firstLine}`);
        // Callers
        for (const c of callerList.slice(0, MAX_CALLERS)) {
          console.log(
            `<- ${c.symbol}\t${c.file ? `${rel(c.file)}:${c.line + 1}` : "(not indexed)"}`,
          );
        }
        if (callerList.length > MAX_CALLERS) {
          console.log(`<- ... ${callerList.length - MAX_CALLERS} more`);
        }
        // Callees
        for (const c of calleeList.slice(0, MAX_CALLEES)) {
          console.log(
            `-> ${c.symbol}\t${c.file ? `${rel(c.file)}:${c.line + 1}` : "(not indexed)"}`,
          );
        }
        if (calleeList.length > MAX_CALLEES) {
          console.log(`-> ... ${calleeList.length - MAX_CALLEES} more`);
        }
      } else {
        // Rich output
        const exportedStr = exported ? ", exported" : "";
        console.log(
          `${style.bold(`peek: ${center.symbol}`)}  ${style.dim(`${rel(center.file)}:${center.line + 1}`)}  ${style.dim(`[${center.role}${exportedStr}]`)}`,
        );
        console.log();

        // Signature with collapsed body
        const { signature } = extractSignature(center.file, startLine, endLine);
        for (const line of signature.split("\n")) {
          console.log(`  ${line}`);
        }
        console.log();

        // Callers
        if (callerList.length > 0) {
          const shown = callerList.slice(0, MAX_CALLERS);
          console.log(
            style.bold(`callers (${callerList.length}):`),
          );
          for (const c of shown) {
            if (c.file) {
              console.log(
                `  ${style.blue("\u2190")} ${style.green(c.symbol.padEnd(25))} ${style.dim(`${rel(c.file)}:${c.line + 1}`)}`,
              );
            } else {
              console.log(
                `  ${style.blue("\u2190")} ${c.symbol.padEnd(25)} ${style.dim("(not indexed)")}`,
              );
            }
          }
          if (callerList.length > MAX_CALLERS) {
            console.log(
              style.dim(`  ... and ${callerList.length - MAX_CALLERS} more`),
            );
          }
        } else {
          console.log(style.dim("No known callers."));
        }

        console.log();

        // Callees
        if (calleeList.length > 0) {
          const shown = calleeList.slice(0, MAX_CALLEES);
          console.log(
            style.bold(`callees (${calleeList.length}):`),
          );
          for (const c of shown) {
            if (c.file) {
              console.log(
                `  ${style.cyan("\u2192")} ${style.green(c.symbol.padEnd(25))} ${style.dim(`${rel(c.file)}:${c.line + 1}`)}`,
              );
            } else {
              console.log(
                `  ${style.cyan("\u2192")} ${c.symbol.padEnd(25)} ${style.dim("(not indexed)")}`,
              );
            }
          }
          if (calleeList.length > MAX_CALLEES) {
            console.log(
              style.dim(`  ... and ${calleeList.length - MAX_CALLEES} more`),
            );
          }
        } else {
          console.log(style.dim("No known callees."));
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Peek failed:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });

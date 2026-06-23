import * as fs from "node:fs";
import { Command } from "commander";
import { isBuiltinCallee, resolveCallSites } from "../lib/graph/callsites";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { groupByLanguage } from "../lib/utils/language";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
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
): { signature: string; signatureOnly: string; bodyLines: number } {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const chunk = lines.slice(startLine, endLine + 1);
    const bodyLines = chunk.length;

    // Find the signature: everything up to and including the opening brace.
    // Only treat `{` / `=>` as the body boundary once the parameter list's
    // parens are balanced — object-literal param types (`cached: { … }`)
    // contain braces mid-signature and must not end it.
    const sigLines: string[] = [];
    let parenDepth = 0;
    for (const line of chunk) {
      sigLines.push(line);
      for (const ch of line) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }
      if (parenDepth <= 0 && (line.includes("{") || line.includes("=>"))) {
        break;
      }
      if (sigLines.length >= 12) break; // degenerate input — bail
    }

    // If we only got one line and it's the whole function, collapse it
    if (sigLines.length >= bodyLines) {
      const whole = chunk.join("\n");
      return { signature: whole, signatureOnly: whole, bodyLines: 0 };
    }

    const sig = sigLines.join("\n");
    const remaining = bodyLines - sigLines.length;
    return {
      signature: `${sig}\n    // ... (${remaining} lines)\n  }`,
      signatureOnly: sig,
      bodyLines,
    };
  } catch {
    return {
      signature: "(source not available)",
      signatureOnly: "(source not available)",
      bodyLines: 0,
    };
  }
}

export const peek = new Command("peek")
  .description("Compact symbol overview: signature + callers + callees")
  .argument("<symbol>", "The symbol to peek at")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
  )
  .option("--agent", "Compact output for AI agents", false)
  .option("--no-tests", "Suppress the tests footer")
  .action(async (symbol, opts) => {
    let vectorDb: VectorDB | null = null;
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const { resolveScope, buildScopeWhere } = await import(
        "../lib/utils/scope-filter"
      );
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });
      const scopeWhere = (cond: string) => buildScopeWhere(scope, cond);

      // Cross-language disambiguation: when the symbol is defined in 2+
      // languages, refuse to silently pick one. The graph builder otherwise
      // picks one chunk arbitrarily and lists callers from a different
      // language — verified failure mode.
      // Same-language multi-definition is reported as a note instead (below):
      // the first definition still wins, but the agent learns it guessed.
      let otherDefs: Array<{ path: string; startLine: number }> = [];
      {
        const tableForCheck = await vectorDb.ensureTable();
        const allDefs = await tableForCheck
          .query()
          .select(["path", "start_line"])
          .where(
            scopeWhere(
              `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`,
            ),
          )
          .limit(20)
          .toArray();
        const chunks = allDefs.map((row: any) => ({
          path: String(row.path || ""),
          startLine: Number(row.start_line || 0),
        }));
        // Dedupe by file: split sub-chunks of one definition share a path,
        // while genuine ambiguity (same name defined elsewhere) crosses files.
        const distinct = new Map<string, { path: string; startLine: number }>();
        for (const c of chunks) {
          if (!distinct.has(c.path)) distinct.set(c.path, c);
        }
        otherDefs = [...distinct.values()];
        const byLang = groupByLanguage(chunks);
        if (byLang.size >= 2) {
          const rel = (p: string) =>
            p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
          const lines = [
            `Symbol '${symbol}' is defined in multiple languages:`,
          ];
          for (const [lang, group] of byLang) {
            const c = group[0];
            lines.push(
              `  ${lang.padEnd(6)} ${rel(c.path)}:${c.startLine + 1}`,
            );
          }
          lines.push(
            `Disambiguate with --root or pin to a path: gmax peek ${symbol} --root <project-root>`,
          );
          console.log(lines.join("\n"));
          process.exitCode = 1;
          return;
        }
      }

      const graphBuilder = new GraphBuilder(
        vectorDb,
        scope.pathPrefix,
        scope.excludePrefixes,
      );
      const graph = await graphBuilder.buildGraph(symbol);

      if (!graph.center) {
        console.log(
          symbolNotFoundLines(symbol, {
            agent: opts.agent,
            dim: style.dim,
            bold: style.bold,
          }).join("\n"),
        );
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
      const metaRows = await table
        .query()
        .select(["is_exported", "start_line", "end_line"])
        .where(
          scopeWhere(
            `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`,
          ),
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

      // Re-anchor chunk-level caller rows to actual call sites and dedupe —
      // getCallers() returns one row per chunk, which multiplies callers for
      // classes split across many chunks (verified: 3 real call sites → 66).
      const resolvedCallers = resolveCallSites(callerList, symbol).map((c) => ({
        symbol: c.symbol,
        file: c.file,
        line: c.snippetLine ?? c.line,
      }));

      // Builtins listed as "(not indexed)" callees (trunc, now, filter, …)
      // are noise; project symbols always resolve so they're unaffected.
      // Dedupe by symbol — repeated references arrive once per chunk.
      const seenCallees = new Set<string>();
      const calleeList = graph.callees
        .filter((c) => c.file || !isBuiltinCallee(c.symbol))
        .filter((c) => {
          if (seenCallees.has(c.symbol)) return false;
          seenCallees.add(c.symbol);
          return true;
        })
        .map((c) => ({
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
        if (otherDefs.length > 1) {
          const others = otherDefs
            .filter((d) => d.path !== center.file)
            .slice(0, 4)
            .map((d) => `${rel(d.path)}:${d.startLine + 1}`);
          if (others.length > 0) {
            console.log(
              `also-defined: ${others.join(", ")} — showing the first; pin with --in <subpath>`,
            );
          }
        }
        // Signature — all lines up to the opening brace, collapsed to one
        // line so parameters survive (first-line-only loses them).
        const { signatureOnly } = extractSignature(
          center.file,
          startLine,
          endLine,
        );
        const sigOnly = signatureOnly
          .split("\n")
          .map((l) => l.trim())
          .join(" ")
          .replace(/\s+/g, " ");
        console.log(`sig: ${sigOnly}`);
        // Callers
        for (const c of resolvedCallers.slice(0, MAX_CALLERS)) {
          console.log(
            `<- ${c.symbol}\t${c.file ? `${rel(c.file)}:${c.line + 1}` : "(not indexed)"}`,
          );
        }
        if (resolvedCallers.length > MAX_CALLERS) {
          console.log(`<- ... ${resolvedCallers.length - MAX_CALLERS} more`);
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
        if (opts.tests !== false) {
          const { fetchTestsForFooter, renderTestsFooterAgent } = await import(
            "../lib/utils/tests-footer"
          );
          const tests = await fetchTestsForFooter(
            symbol,
            vectorDb,
            scope.pathPrefix,
            scope.excludePrefixes,
          );
          if (tests && tests.length > 0) {
            for (const line of renderTestsFooterAgent(tests, projectRoot)) {
              console.log(line);
            }
          }
        }
      } else {
        // Rich output
        const exportedStr = exported ? ", exported" : "";
        console.log(
          `${style.bold(`peek: ${center.symbol}`)}  ${style.dim(`${rel(center.file)}:${center.line + 1}`)}  ${style.dim(`[${center.role}${exportedStr}]`)}`,
        );
        if (otherDefs.length > 1) {
          const others = otherDefs
            .filter((d) => d.path !== center.file)
            .slice(0, 4)
            .map((d) => `${rel(d.path)}:${d.startLine + 1}`);
          if (others.length > 0) {
            console.log(
              style.dim(
                `  also defined in: ${others.join(", ")} — showing the first; pin with --in <subpath>`,
              ),
            );
          }
        }
        console.log();

        // Signature with collapsed body
        const { signature } = extractSignature(center.file, startLine, endLine);
        for (const line of signature.split("\n")) {
          console.log(`  ${line}`);
        }
        console.log();

        // Callers
        if (resolvedCallers.length > 0) {
          const shown = resolvedCallers.slice(0, MAX_CALLERS);
          console.log(
            style.bold(`callers (${resolvedCallers.length}):`),
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
          if (resolvedCallers.length > MAX_CALLERS) {
            console.log(
              style.dim(`  ... and ${resolvedCallers.length - MAX_CALLERS} more`),
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

        if (opts.tests !== false) {
          const { fetchTestsForFooter, renderTestsFooterHuman } = await import(
            "../lib/utils/tests-footer"
          );
          const tests = await fetchTestsForFooter(
            symbol,
            vectorDb,
            scope.pathPrefix,
            scope.excludePrefixes,
          );
          if (tests && tests.length > 0) {
            for (const line of renderTestsFooterHuman(tests, projectRoot)) {
              console.log(line);
            }
          }
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

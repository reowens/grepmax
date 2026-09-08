import * as fs from "node:fs";
import { Command } from "commander";
import {
  callGraphVerb,
  type GraphPeekResult,
  runGraphPeek,
} from "../lib/daemon/graph-handler";
import { isBuiltinCallee, resolveCallSites } from "../lib/graph/callsites";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { groupByLanguage } from "../lib/utils/language";
import { resolveContainedFile } from "../lib/utils/path-containment";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

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
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
): { signature: string; signatureOnly: string; bodyLines: number } {
  try {
    const content = fs.readFileSync(
      resolveContainedFile(projectRoot, filePath),
      "utf-8",
    );
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
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--agent", "Compact output for AI agents", false)
  .option("--no-tests", "Suppress the tests footer")
  .action(async (symbol, opts) => {
    const local: { db: VectorDB | null } = { db: null };
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

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      // One round trip for everything peek needs out of the store: the
      // defining chunks, the graph, the chunk metadata, and the tests footer.
      // The signature below is read from the working tree by this process.
      const store = await callGraphVerb<GraphPeekResult>("graph.peek", {
        projectRoot,
        scope,
        payload: {
          target: symbol,
          depth,
          includeTests: opts.tests !== false,
        },
        render: (resp) => resp.peek as GraphPeekResult,
        inProcess: () => {
          local.db ??= new VectorDB(ensureProjectPaths(projectRoot).lancedbDir);
          return runGraphPeek(local.db, {
            symbol,
            depth,
            scope,
            includeTests: opts.tests !== false,
          });
        },
      });

      // Cross-language disambiguation: when the symbol is defined in 2+
      // languages, refuse to silently pick one. The graph builder otherwise
      // picks one chunk arbitrarily and lists callers from a different
      // language — verified failure mode.
      // Same-language multi-definition is reported as a note instead (below):
      // the first definition still wins, but the agent learns it guessed.
      let otherDefs: Array<{ path: string; startLine: number }> = [];
      {
        const chunks = store.defChunks;
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
            lines.push(`  ${lang.padEnd(6)} ${rel(c.path)}:${c.startLine + 1}`);
          }
          lines.push(
            `Disambiguate with --root or pin to a path: gmax peek ${symbol} --root <project-root>`,
          );
          console.log(lines.join("\n"));
          process.exitCode = 1;
          return;
        }
      }

      const graph = store.graph;

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
        p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;

      // Chunk metadata for is_exported and end_line
      const meta = store.meta;
      const exported = meta?.isExported === true;
      const startLine = meta ? meta.startLine : center.line;
      const endLine = meta ? meta.endLine : center.line;

      // Multi-hop callers when depth > 1
      type CallerEntry = {
        symbol: string;
        file: string;
        line: number;
        edgeKind?: "free" | "member" | "type";
      };
      let callerList: CallerEntry[];
      if (depth > 1 && store.callerTree) {
        // Flatten caller tree
        const flat: CallerEntry[] = [];
        function walkCallers(tree: any[]) {
          for (const t of tree) {
            flat.push({
              symbol: t.node.symbol,
              file: t.node.file,
              line: t.node.line,
              edgeKind: t.node.edgeKind,
            });
            walkCallers(t.callers);
          }
        }
        walkCallers(store.callerTree);
        callerList = flat;
      } else {
        callerList = graph.callers.map((c) => ({
          symbol: c.symbol,
          file: c.file,
          line: c.line,
          edgeKind: c.edgeKind,
        }));
      }

      // Confidence per caller symbol: getCallers sorts free calls first, so the
      // first edgeKind seen for a symbol is its highest-confidence one.
      const edgeKindBySym = new Map<string, CallerEntry["edgeKind"]>();
      for (const c of callerList) {
        if (!edgeKindBySym.has(c.symbol))
          edgeKindBySym.set(c.symbol, c.edgeKind);
      }

      // Re-anchor chunk-level caller rows to actual call sites and dedupe —
      // getCallers() returns one row per chunk, which multiplies callers for
      // classes split across many chunks (verified: 3 real call sites → 66).
      const readableCallers = callerList.flatMap((caller) => {
        try {
          return [
            {
              ...caller,
              file: resolveContainedFile(projectRoot, caller.file),
            },
          ];
        } catch {
          return [];
        }
      });
      const resolvedCallers = resolveCallSites(readableCallers, symbol).map(
        (c) => ({
          symbol: c.symbol,
          file: c.file,
          line: c.snippetLine ?? c.line,
          edgeKind: edgeKindBySym.get(c.symbol),
        }),
      );

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

      // Inferred-caller marker: `member` = receiver-unverified `x.T()`, `type` =
      // a type-position reference (not a call). Free calls render clean — the
      // trustworthy default — so only guesses carry a tag.
      const kindTag = (k?: "free" | "member" | "type") =>
        k === "member" || k === "type" ? ` (${k})` : "";

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
          projectRoot,
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
            `<- ${c.symbol}\t${c.file ? `${rel(c.file)}:${c.line + 1}` : "(not indexed)"}${kindTag(c.edgeKind)}`,
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
          const { renderTestsFooterAgent } = await import(
            "../lib/utils/tests-footer"
          );
          const tests = store.footerTests;
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
        const { signature } = extractSignature(
          projectRoot,
          center.file,
          startLine,
          endLine,
        );
        for (const line of signature.split("\n")) {
          console.log(`  ${line}`);
        }
        console.log();

        // Callers
        if (resolvedCallers.length > 0) {
          const shown = resolvedCallers.slice(0, MAX_CALLERS);
          console.log(style.bold(`callers (${resolvedCallers.length}):`));
          for (const c of shown) {
            if (c.file) {
              console.log(
                `  ${style.blue("\u2190")} ${style.green(c.symbol.padEnd(25))} ${style.dim(`${rel(c.file)}:${c.line + 1}`)}${style.dim(kindTag(c.edgeKind))}`,
              );
            } else {
              console.log(
                `  ${style.blue("\u2190")} ${c.symbol.padEnd(25)} ${style.dim("(not indexed)")}${style.dim(kindTag(c.edgeKind))}`,
              );
            }
          }
          if (resolvedCallers.length > MAX_CALLERS) {
            console.log(
              style.dim(
                `  ... and ${resolvedCallers.length - MAX_CALLERS} more`,
              ),
            );
          }
        } else {
          console.log(style.dim("No known callers."));
        }

        console.log();

        // Callees
        if (calleeList.length > 0) {
          const shown = calleeList.slice(0, MAX_CALLEES);
          console.log(style.bold(`callees (${calleeList.length}):`));
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
          const { renderTestsFooterHuman } = await import(
            "../lib/utils/tests-footer"
          );
          const tests = store.footerTests;
          if (tests && tests.length > 0) {
            for (const line of renderTestsFooterHuman(tests, projectRoot)) {
              console.log(line);
            }
          }
        }
      }
    } catch (error) {
      // A sandbox refusal is already one actionable line; a "Peek failed:"
      // prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error("Peek failed:", message);
        process.exitCode = 1;
      }
    } finally {
      if (local.db) {
        try {
          await local.db.close();
        } catch {}
      }
      await gracefulExit();
    }
  });

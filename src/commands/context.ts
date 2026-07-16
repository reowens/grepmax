import * as fs from "node:fs";
import { Command } from "commander";
import { Searcher } from "../lib/search/searcher";
import { Skeletonizer } from "../lib/skeleton";
import type { ChunkType, FileMetadata } from "../lib/store/types";
import { VectorDB } from "../lib/store/vector-db";
import { toArr } from "../lib/utils/arrow";
import { packByBudget } from "../lib/utils/budget-pack";
import { gracefulExit } from "../lib/utils/exit";
import { readContainedTextFileSync } from "../lib/utils/file-utils";
import { escapeSqlString, pathStartsWith } from "../lib/utils/filter-builder";
import {
  isPathWithin,
  resolveContainedExistingPath,
  resolveContainedPath,
} from "../lib/utils/path-containment";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type BudgetedSections = {
  sections: string[];
  tokensUsed: number;
};

function addSection(
  state: BudgetedSections,
  text: string,
  budget: number,
): boolean {
  const tokens = estimateTokens(text);
  if (state.tokensUsed + tokens > budget) return false;
  state.sections.push(text);
  state.tokensUsed += tokens;
  return true;
}

function relPath(projectRoot: string, p: string): string {
  return p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
}

function chunkPath(chunk: ChunkType): string {
  const metadata = chunk.metadata as FileMetadata | undefined;
  return String((chunk as any).path || metadata?.path || "");
}

function chunkStartLine(chunk: ChunkType): number {
  return Number(
    (chunk as any).start_line ??
      (chunk as any).startLine ??
      chunk.generated_metadata?.start_line ??
      0,
  );
}

function chunkEndLine(chunk: ChunkType): number {
  const start = chunkStartLine(chunk);
  return Number(
    (chunk as any).end_line ??
      (chunk as any).endLine ??
      chunk.generated_metadata?.end_line ??
      start,
  );
}

/**
 * The definition line of `parentSymbol` nearest above `startLine` — used to
 * give a mid-function sub-chunk extract its enclosing signature. Requires a
 * definition-shaped line, not just any mention, so recursive calls or
 * references between the definition and the chunk don't win.
 */
export function findEnclosingSignature(
  lines: string[],
  startLine: number,
  parentSymbol: string,
): { text: string; line: number } | null {
  if (!parentSymbol || !/^\w+$/.test(parentSymbol)) return null;
  const defRe = new RegExp(
    `(?:\\b(?:class|function|interface|enum|struct|trait|impl|def|fn|type|const|let|var)\\b[^=]*\\b${parentSymbol}\\b|\\b${parentSymbol}\\b\\s*[(:=])`,
  );
  for (let i = Math.min(startLine, lines.length) - 1; i >= 0; i--) {
    if (defRe.test(lines[i])) {
      return { text: lines[i].trim(), line: i };
    }
  }
  return null;
}

async function renderPathContext(
  target: string,
  absPath: string,
  projectRoot: string,
  budget: number,
): Promise<BudgetedSections> {
  const state: BudgetedSections = {
    sections: [],
    tokensUsed: 0,
  };
  const header = `=== Context: "${target}" ===`;
  addSection(state, header, budget);

  const stat = fs.statSync(absPath);
  const targetSection = [
    "\n## Target",
    `${relPath(projectRoot, absPath)} [${stat.isDirectory() ? "directory" : "file"}]`,
  ].join("\n");
  addSection(state, targetSection, budget);

  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
    if (entries.length > 0) {
      addSection(
        state,
        ["\n## Directory Entries", ...entries].join("\n"),
        budget,
      );
    }
    return state;
  }

  const content = readContainedTextFileSync(projectRoot, absPath);
  const skeletonizer = new Skeletonizer();
  await skeletonizer.init();
  if (skeletonizer.isSupported(absPath).supported) {
    try {
      const result = await skeletonizer.skeletonizeFile(absPath, content);
      if (result.success) {
        addSection(
          state,
          [
            "\n## File Structure",
            `--- ${relPath(projectRoot, absPath)} (skeleton, ~${result.tokenEstimate} tokens) ---`,
            result.skeleton,
          ].join("\n"),
          budget,
        );
      }
    } catch {
      // Skeleton is a convenience in path mode; fall through to excerpt.
    }
  }

  const lines = content.split("\n");
  const excerptLines = lines.slice(0, Math.min(lines.length, 120));
  const omitted =
    lines.length > excerptLines.length
      ? `\n... (+${lines.length - excerptLines.length} more lines)`
      : "";
  addSection(
    state,
    [
      "\n## File Excerpt",
      `--- ${relPath(projectRoot, absPath)}:1 ---`,
      `${excerptLines.join("\n")}${omitted}`,
    ].join("\n"),
    budget,
  );

  return state;
}

export const context = new Command("context")
  .description(
    "Generate a token-budgeted topic summary (search + skeleton + extract)",
  )
  .argument("<topic>", "Natural language topic or directory path")
  .option("--budget <tokens>", "Max tokens for output (default 4000)", "4000")
  .option(
    "-m, --max-results <n>",
    "Initial search result limit (default 10)",
    "10",
  )
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (topic, opts) => {
    const budget = Number.parseInt(opts.budget || "4000", 10) || 4000;
    const maxResults = Number.parseInt(opts.maxResults || "10", 10) || 10;
    let vectorDb: VectorDB | null = null;

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const pathTarget = resolveContainedExistingPath(projectRoot, topic, {
        cwd: root,
        onOutside: "throw",
      });
      if (pathTarget) {
        const rendered = await renderPathContext(
          topic,
          pathTarget,
          projectRoot,
          budget,
        );
        rendered.sections.push(
          `\n(~${rendered.tokensUsed}/${budget} tokens used)`,
        );
        console.log(rendered.sections.join("\n"));
        return;
      }

      const searcher = new Searcher(vectorDb);

      // Phase 1: Semantic search
      const response = await searcher.search(
        topic,
        maxResults,
        { rerank: true },
        {},
        `${projectRoot}/`,
      );
      const scopedData = response.data.filter((result) =>
        isPathWithin(projectRoot, chunkPath(result)),
      );
      if (scopedData.length === 0) {
        console.log(`No results found for "${topic}".`);
        return;
      }

      let tokensUsed = 0;
      const sections: string[] = [];

      // Header
      const header = `=== Context: "${topic}" ===`;
      sections.push(header);
      tokensUsed += estimateTokens(header);

      // Phase 2: Entry points (ORCHESTRATION role results)
      const orchestrators = scopedData.filter(
        (r) => r.role === "ORCHESTRATION",
      );
      const entryPoints =
        orchestrators.length > 0 ? orchestrators : scopedData.slice(0, 3);

      const epSection: string[] = ["\n## Entry Points"];
      for (const r of entryPoints.slice(0, 5)) {
        const p = chunkPath(r);
        const line = chunkStartLine(r);
        const parentSym = String((r as any).parent_symbol || "");
        const sym =
          toArr((r as any).defined_symbols)?.[0] ??
          (parentSym ? `(in ${parentSym})` : "");
        const role = String((r as any).role || "IMPLEMENTATION");
        epSection.push(
          `${relPath(projectRoot, p)}:${line + 1} ${sym} [${role}]`,
        );
      }
      const epText = epSection.join("\n");
      if (tokensUsed + estimateTokens(epText) <= budget) {
        sections.push(epText);
        tokensUsed += estimateTokens(epText);
      }

      // Phase 3: Key function bodies (top 2-3 results). Token-aware packing
      // (knapsack-continue): an oversized body is skipped so a smaller, still-
      // relevant one can fill the remaining budget instead of aborting the rest.
      const topChunks = entryPoints.slice(0, 3);
      const bodyBlobs = topChunks.map((r) => {
        let absP: string;
        try {
          absP = resolveContainedPath(projectRoot, chunkPath(r), {
            verifyExistingTarget: true,
          });
        } catch {
          return null;
        }
        const startLine = chunkStartLine(r);
        const endLine = chunkEndLine(r);
        const sym = toArr((r as any).defined_symbols)?.[0] ?? "";
        const parentSym = String((r as any).parent_symbol || "");
        try {
          const content = readContainedTextFileSync(projectRoot, absP);
          const allLines = content.split("\n");
          const body = allLines
            .slice(startLine, Math.min(endLine + 1, allLines.length))
            .join("\n");
          // A sub-chunk that starts mid-function has no defined symbol of its
          // own — prepend the enclosing definition's signature so the extract
          // isn't headless code.
          let enclosing = "";
          let label = sym;
          if (!sym && parentSym) {
            label = `(in ${parentSym})`;
            const sig = findEnclosingSignature(allLines, startLine, parentSym);
            if (sig) {
              enclosing = `${sig.text}  // :${sig.line + 1}\n// ...\n`;
            }
          }
          return `\n--- ${relPath(projectRoot, absP)}:${startLine + 1} ${label} ---\n${enclosing}${body}`;
        } catch {
          return null; // File not readable — drop
        }
      });
      const bodyCandidates = bodyBlobs.map((blob, idx) => ({
        tokens: blob ? estimateTokens(blob) : Number.POSITIVE_INFINITY,
        score: topChunks.length - idx, // preserve relevance order
      }));
      const bodyPack = packByBudget(bodyCandidates, budget - tokensUsed, {
        atLeastOne: false,
      });
      const bodySection: string[] = ["\n## Key Functions"];
      for (const i of bodyPack.selected) {
        const blob = bodyBlobs[i];
        if (!blob) continue;
        bodySection.push(blob);
      }
      if (bodySection.length > 1) {
        sections.push(bodySection.join(""));
        tokensUsed += bodyPack.tokensUsed;
      }

      // Phase 4: File skeletons for unique files
      const uniqueFiles = [
        ...new Set(
          scopedData
            .map((r) => {
              try {
                return resolveContainedPath(projectRoot, chunkPath(r), {
                  verifyExistingTarget: true,
                });
              } catch {
                return "";
              }
            })
            .filter(Boolean),
        ),
      ].slice(0, 5);

      const skelSection: string[] = ["\n## File Structure"];
      const skeletonizer = new Skeletonizer();
      await skeletonizer.init();

      for (const absP of uniqueFiles) {
        if (!skeletonizer.isSupported(absP).supported) continue;
        try {
          const content = readContainedTextFileSync(projectRoot, absP);
          const result = await skeletonizer.skeletonizeFile(absP, content);
          if (!result.success) continue;

          const blob = `\n--- ${relPath(projectRoot, absP)} (skeleton, ~${result.tokenEstimate} tokens) ---\n${result.skeleton}`;
          const blobTokens = estimateTokens(blob);
          // Skip an oversized skeleton but keep trying smaller ones (a verbose
          // file shouldn't starve the rest of the budget).
          if (tokensUsed + blobTokens > budget) continue;
          skelSection.push(blob);
          tokensUsed += blobTokens;
        } catch {
          // Skip unreadable files
        }
      }
      if (skelSection.length > 1) {
        sections.push(skelSection.join(""));
      }

      // Phase 5: Related files summary
      const table = await vectorDb.ensureTable();
      const allSymbols = new Set<string>();
      for (const r of scopedData) {
        for (const s of toArr(r.defined_symbols)) allSymbols.add(s);
      }

      if (allSymbols.size > 0) {
        const pathScope = pathStartsWith(`${projectRoot}/`);
        const relatedCounts = new Map<string, number>();
        const searchedFiles = new Set(uniqueFiles);

        for (const sym of [...allSymbols].slice(0, 20)) {
          const rows = await table
            .query()
            .select(["path"])
            .where(
              `array_contains(referenced_symbols, '${escapeSqlString(sym)}') AND ${pathScope}`,
            )
            .limit(5)
            .toArray();
          for (const row of rows) {
            const p = String((row as any).path || "");
            if (searchedFiles.has(p)) continue;
            relatedCounts.set(p, (relatedCounts.get(p) || 0) + 1);
          }
        }

        const topRelated = Array.from(relatedCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        if (topRelated.length > 0) {
          const relSection: string[] = ["\n## Related Files"];
          for (const [p, count] of topRelated) {
            relSection.push(
              `${relPath(projectRoot, p)} — ${count} shared symbol${count > 1 ? "s" : ""}`,
            );
          }
          const relText = relSection.join("\n");
          if (tokensUsed + estimateTokens(relText) <= budget) {
            sections.push(relText);
            tokensUsed += estimateTokens(relText);
          }
        }
      }

      // Footer
      sections.push(`\n(~${tokensUsed}/${budget} tokens used)`);

      console.log(sections.join("\n"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Context generation failed:", msg);
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

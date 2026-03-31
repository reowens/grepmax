import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { Searcher } from "../lib/search/searcher";
import { Skeletonizer } from "../lib/skeleton";
import { VectorDB } from "../lib/store/vector-db";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      // Phase 1: Semantic search
      const response = await searcher.search(topic, maxResults, { rerank: true }, {}, projectRoot);
      if (response.data.length === 0) {
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
      const orchestrators = response.data.filter(
        (r) => r.role === "ORCHESTRATION",
      );
      const entryPoints =
        orchestrators.length > 0 ? orchestrators : response.data.slice(0, 3);

      const epSection: string[] = ["\n## Entry Points"];
      for (const r of entryPoints.slice(0, 5)) {
        const p = String((r as any).path || (r.metadata as any)?.path || "");
        const line = Number((r as any).start_line ?? 0);
        const sym = toArr((r as any).defined_symbols)?.[0] ?? "";
        const role = String((r as any).role || "IMPLEMENTATION");
        epSection.push(`${rel(p)}:${line + 1} ${sym} [${role}]`);
      }
      const epText = epSection.join("\n");
      if (tokensUsed + estimateTokens(epText) <= budget) {
        sections.push(epText);
        tokensUsed += estimateTokens(epText);
      }

      // Phase 3: Key function bodies (top 2-3 results)
      const topChunks = entryPoints.slice(0, 3);
      const bodySection: string[] = ["\n## Key Functions"];
      for (const r of topChunks) {
        const absP = String((r as any).path || "");
        const startLine = Number((r as any).start_line ?? 0);
        const endLine = Number((r as any).end_line ?? startLine);
        const sym = toArr((r as any).defined_symbols)?.[0] ?? "";

        try {
          const content = fs.readFileSync(absP, "utf-8");
          const allLines = content.split("\n");
          const body = allLines
            .slice(startLine, Math.min(endLine + 1, allLines.length))
            .join("\n");

          const blob = `\n--- ${rel(absP)}:${startLine + 1} ${sym} ---\n${body}`;
          const blobTokens = estimateTokens(blob);
          if (tokensUsed + blobTokens > budget) break;
          bodySection.push(blob);
          tokensUsed += blobTokens;
        } catch {
          // File not readable — skip
        }
      }
      if (bodySection.length > 1) {
        sections.push(bodySection.join(""));
      }

      // Phase 4: File skeletons for unique files
      const uniqueFiles = [
        ...new Set(
          response.data
            .map((r) => String((r as any).path || ""))
            .filter(Boolean),
        ),
      ].slice(0, 5);

      const skelSection: string[] = ["\n## File Structure"];
      const skeletonizer = new Skeletonizer();
      await skeletonizer.init();

      for (const absP of uniqueFiles) {
        if (!skeletonizer.isSupported(absP).supported) continue;
        try {
          const content = fs.readFileSync(absP, "utf-8");
          const result = await skeletonizer.skeletonizeFile(absP, content);
          if (!result.success) continue;

          const blob = `\n--- ${rel(absP)} (skeleton, ~${result.tokenEstimate} tokens) ---\n${result.skeleton}`;
          const blobTokens = estimateTokens(blob);
          if (tokensUsed + blobTokens > budget) break;
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
      for (const r of response.data) {
        for (const s of toArr(r.defined_symbols)) allSymbols.add(s);
      }

      if (allSymbols.size > 0) {
        const pathScope = `path LIKE '${escapeSqlString(projectRoot)}/%'`;
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
              `${rel(p)} — ${count} shared symbol${count > 1 ? "s" : ""}`,
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
        try { await vectorDb.close(); } catch {}
      }
      await gracefulExit();
    }
  });

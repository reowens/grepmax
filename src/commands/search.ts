import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { Skeletonizer } from "../lib/skeleton";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import type {
  ChunkType,
  FileMetadata,
  SearchResponse,
} from "../lib/store/types";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { formatTextResults, type TextResult } from "../lib/utils/formatter";
import { extractImports } from "../lib/utils/import-extractor";
import { isLocked } from "../lib/utils/lock";
import { getProject } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { getServerForProject } from "../lib/utils/server-registry";

function toTextResults(data: SearchResponse["data"]): TextResult[] {
  return data.map((r) => {
    const rawPath =
      typeof (r.metadata as FileMetadata | undefined)?.path === "string"
        ? ((r.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof r.generated_metadata?.start_line === "number"
        ? r.generated_metadata.start_line
        : 0;
    const end =
      typeof r.generated_metadata?.end_line === "number"
        ? r.generated_metadata.end_line
        : start + Math.max(0, (r.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      score: r.score,
      content: r.text || "",
      chunk_type: r.generated_metadata?.type,
      start_line: start,
      end_line: end,
    };
  });
}

type CompactHit = {
  path: string;
  range: string;
  start_line: number;
  end_line: number;
  role?: string;
  confidence?: string;
  score?: number;
  defined?: string[];
  preview?: string;
  summary?: string;
};

function getPreviewText(chunk: ChunkType): string {
  const maxLen = 140;
  const lines =
    chunk.text
      ?.split("\n")
      .map((l) => l.trim())
      .filter(Boolean) ?? [];
  let preview = lines[0] ?? "";

  if (!preview && chunk.defined_symbols?.length) {
    preview = chunk.defined_symbols[0] ?? "";
  }

  if (preview.length > maxLen) {
    preview = `${preview.slice(0, maxLen)}...`;
  }
  return preview;
}

function toCompactHits(data: SearchResponse["data"]): CompactHit[] {
  return data.map((chunk) => {
    const rawPath =
      typeof (chunk.metadata as FileMetadata | undefined)?.path === "string"
        ? ((chunk.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof chunk.generated_metadata?.start_line === "number"
        ? chunk.generated_metadata.start_line
        : 0;
    const end =
      typeof chunk.generated_metadata?.end_line === "number"
        ? chunk.generated_metadata.end_line
        : start + Math.max(0, (chunk.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      range: `${start + 1}-${end + 1}`,
      start_line: start,
      end_line: end,
      role: chunk.role,
      confidence: chunk.confidence,
      score: chunk.score,
      defined: Array.isArray(chunk.defined_symbols)
        ? chunk.defined_symbols.slice(0, 3)
        : typeof chunk.defined_symbols === "string"
          ? [chunk.defined_symbols]
          : typeof (chunk.defined_symbols as any)?.toArray === "function"
            ? ((chunk.defined_symbols as any).toArray() as string[]).slice(0, 3)
            : [],
      preview: getPreviewText(chunk),
      summary: typeof chunk.summary === "string" ? chunk.summary : undefined,
    };
  });
}

function compactRole(role?: string): string {
  if (!role) return "UNK";
  if (role.startsWith("ORCH")) return "ORCH";
  if (role.startsWith("DEF")) return "DEF";
  if (role.startsWith("IMP")) return "IMPL";
  return role.slice(0, 4).toUpperCase();
}

function compactConf(conf?: string): string {
  if (!conf) return "U";
  const c = conf.toUpperCase();
  if (c.startsWith("H")) return "H";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("L")) return "L";
  return "U";
}

function compactScore(score?: number): string {
  if (typeof score !== "number") return "";
  const fixed = score.toFixed(3);
  return fixed
    .replace(/^0\./, ".")
    .replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function padR(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return s + " ".repeat(n);
}
function padL(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return " ".repeat(n) + s;
}

function formatCompactTSV(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
): string {
  if (!hits.length) return "No matches found.";
  const lines: string[] = [];
  lines.push(`gmax hits\tquery=${query}\tcount=${hits.length}`);
  lines.push("path\tlines\tscore\trole\tconf\tdefined\tsummary");

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",");
    const summary = hit.summary ?? "";
    lines.push([relPath, hit.range, score, role, conf, defs, summary].join("\t"));
  }
  return lines.join("\n");
}

function formatCompactPretty(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  termWidth: number,
  useAnsi: boolean,
): string {
  if (!hits.length) return "No matches found.";

  const dim = (s: string) => (useAnsi ? `\x1b[90m${s}\x1b[0m` : s);
  const bold = (s: string) => (useAnsi ? `\x1b[1m${s}\x1b[0m` : s);

  const wLines = 9;
  const wScore = 6;
  const wRole = 4;
  const wConf = 1;
  const wDef = 20;

  const gutters = 5;
  const fixed = wLines + wScore + wRole + wConf + wDef + gutters;

  const wPath = Math.max(24, Math.min(64, termWidth - fixed));

  const header = `gmax hits  count=${hits.length}  query="${query}"`;

  const cols = [
    padR("path", wPath),
    padR("lines", wLines),
    padL("score", wScore),
    padR("role", wRole),
    padR("c", wConf),
    padR("defined", wDef),
  ].join(" ");

  const out: string[] = [];
  out.push(bold(header));
  out.push(dim(cols));

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",") || "-";
    const displayPath = `${relPath}:${hit.start_line + 1}`;
    const paddedPath = padR(displayPath, wPath);

    const row = [
      paddedPath,
      padR(hit.range, wLines),
      padL(score || "", wScore),
      padR(role, wRole),
      padR(conf, wConf),
      padR(truncateEnd(defs, wDef), wDef),
    ].join(" ");

    out.push(row);
  }

  return out.join("\n");
}

function formatCompactTable(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  opts: { isTTY: boolean; plain: boolean },
): string {
  if (!hits.length) return "No matches found.";

  if (!opts.isTTY || opts.plain) {
    return formatCompactTSV(hits, projectRoot, query);
  }

  const termWidth = Math.max(80, process.stdout.columns ?? 120);
  return formatCompactPretty(hits, projectRoot, query, termWidth, true);
}

// Reuse Skeletonizer instance
let globalSkeletonizer: Skeletonizer | null = null;

async function outputSkeletons(
  results: any[],
  projectRoot: string,
  limit: number,
  db?: VectorDB | null,
): Promise<void> {
  const seenPaths = new Set<string>();
  const filesToProcess: string[] = [];

  for (const result of results) {
    const p = (result.metadata as any)?.path;
    if (typeof p === "string" && !seenPaths.has(p)) {
      seenPaths.add(p);
      filesToProcess.push(p);
      if (filesToProcess.length >= limit) break;
    }
  }

  if (filesToProcess.length === 0) {
    console.log("No skeleton matches found.");
    console.log(
      "\nTry: broaden your query, or use `gmax skeleton <path>` to view a specific file's structure.",
    );
    process.exitCode = 1;
    return;
  }

  // Reuse or init skeletonizer for fallbacks
  if (!globalSkeletonizer) {
    globalSkeletonizer = new Skeletonizer();
    // Lazy init only if we actually fallback
  }

  const skeletonOpts = { includeSummary: true };
  const skeletonResults: Array<{
    file: string;
    skeleton: string;
    tokens: number;
    error?: string;
  }> = [];

  for (const filePath of filesToProcess) {
    // Paths from search results are now absolute (centralized index)
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    // 1. Try DB cache
    if (db) {
      const cached = await getStoredSkeleton(db, absPath);
      if (cached) {
        skeletonResults.push({
          file: filePath,
          skeleton: cached,
          tokens: Math.ceil(cached.length / 4), // Rough estimate
        });
        continue;
      }
    }

    // 2. Fallback to fresh generation
    await globalSkeletonizer.init();
    if (!fs.existsSync(absPath)) {
      skeletonResults.push({
        file: filePath,
        skeleton: `// File not found: ${filePath}`,
        tokens: 0,
        error: "File not found",
      });
      continue;
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const res = await globalSkeletonizer.skeletonizeFile(
      absPath,
      content,
      skeletonOpts,
    );
    skeletonResults.push({
      file: filePath,
      skeleton: res.skeleton,
      tokens: res.tokenEstimate,
      error: res.error,
    });
  }

  // Since search doesn't support --json explicitly yet, we just print text.
  // But if we ever add it, we have the structure.
  for (const res of skeletonResults) {
    console.log(res.skeleton);
    console.log(""); // Separator
  }
}

function resultCountHeader(results: any[], maxCount: number): string {
  const files = new Set<string>();
  for (const r of results) {
    const p = (r as any).path ?? (r as any).metadata?.path ?? "";
    if (p) files.add(p);
  }
  const showing =
    results.length < maxCount
      ? `${results.length}`
      : `top ${results.length}`;
  return `Found ${results.length} match${results.length === 1 ? "" : "es"} (showing ${showing}) across ${files.size} file${files.size === 1 ? "" : "s"}`;
}

export const search: Command = new CommanderCommand("search")
  .description("Search code by meaning (default command)")
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "5",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option("--per-file <n>", "Number of matches to show per file", "3")
  .option("--scores", "Show relevance scores", false)
  .option(
    "--min-score <score>",
    "Minimum relevance score (0-1) to include in results",
    "0",
  )
  .option(
    "--compact",
    "Compact hits view (paths + line ranges + role/preview)",
    false,
  )
  .option("--plain", "Disable ANSI colors and use simpler formatting", false)

  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    false,
  )
  .option(
    "-d, --dry-run",
    "Show what would be indexed without actually indexing",
    false,
  )
  .option(
    "--skeleton",
    "Show code skeleton for matching files instead of snippets",
    false,
  )
  .option("--root <dir>", "Search a different project directory")
  .option("--file <name>", "Filter to files matching this name (e.g. 'syncer.ts')")
  .option("--exclude <prefix>", "Exclude files under this path prefix (e.g. 'tests/')")
  .option("--lang <ext>", "Filter by file extension (e.g. 'ts', 'py')")
  .option("--role <role>", "Filter by role: ORCHESTRATION, DEFINITION, IMPLEMENTATION")
  .option("--symbol", "Append call graph after search results", false)
  .option("--imports", "Prepend file imports to each result", false)
  .option("--name <regex>", "Filter results by symbol name regex")
  .option("-C, --context <n>", "Include N lines before/after each result")
  .option("--agent", "Ultra-compact output for AI agents (one line per result)", false)
  .argument("<pattern>", "Natural language query (e.g. \"where do we handle auth?\")")
  .argument("[path]", "Restrict search to this path prefix")
  .addHelpText(
    "after",
    `
Examples:
  gmax "where do we handle authentication?"
  gmax "auth handler" --role ORCHESTRATION --lang ts --plain
  gmax "database" --file syncer.ts --plain
  gmax "VectorDB" --symbol --plain
  gmax "error handling" -C 5 --imports --plain
  gmax "handler" --name "handle.*" --exclude tests/
`,
  )
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: {
      m: string;
      content: boolean;
      perFile: string;
      scores: boolean;
      minScore: string;
      compact: boolean;
      plain: boolean;
      sync: boolean;
      dryRun: boolean;
      skeleton: boolean;
      root: string;
      file: string;
      exclude: string;
      lang: string;
      role: string;
      symbol: boolean;
      imports: boolean;
      name: string;
      context: string;
      agent: boolean;
    } = cmd.optsWithGlobals();

    const root = process.cwd();
    const minScore = Number.isFinite(Number.parseFloat(options.minScore))
      ? Number.parseFloat(options.minScore)
      : 0;
    let vectorDb: VectorDB | null = null;
    const _searchStartMs = Date.now();
    let _searchResultCount = 0;
    let _searchError: string | undefined;

    // Check for running server
    const execPathForServer = exec_path ? path.resolve(exec_path) : root;
    const projectRootForServer =
      findProjectRoot(execPathForServer) ?? execPathForServer;
    const server = getServerForProject(projectRootForServer);

    if (server) {
      try {
        const response = await fetch(`http://localhost:${server.port}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: pattern,
            limit: parseInt(options.m, 10),
            path: exec_path
              ? path.relative(projectRootForServer, path.resolve(exec_path))
              : undefined,
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as { results: any[] };

          const searchResult = { data: body.results };
          const filteredData = searchResult.data.filter(
            (r) => typeof r.score !== "number" || r.score >= minScore,
          );

          if (options.skeleton) {
            await outputSkeletons(
              filteredData,
              projectRootForServer,
              parseInt(options.m, 10),
              // Server doesn't easily expose DB instance here in HTTP client mode,
              // but we are in client. Wait, this text implies "Server Search" block.
              // Client talks to server. The server returns JSON.
              // We don't have DB access here.
              // So we pass null, and it will fallback to generating local skeleton (if file exists locally).
              // This is acceptable for Phase 3.
              null,
            );
            return;
          }

          const compactHits = options.compact
            ? toCompactHits(filteredData)
            : [];

          if (options.compact) {
            if (!compactHits.length) {
              console.log("No matches found.");
              console.log(
                "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
              );
              process.exitCode = 1;
            } else {
              console.log(
                formatCompactTable(compactHits, projectRootForServer, pattern, {
                  isTTY: !!process.stdout.isTTY,
                  plain: !!options.plain,
                }),
              );
            }
            return; // EXIT
          }

          if (!filteredData.length) {
            console.log("No matches found.");
            console.log(
              "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
            );
            process.exitCode = 1;
            return; // EXIT
          }

          const isTTY = process.stdout.isTTY;
          const shouldBePlain = options.plain || !isTTY;

          _searchResultCount = filteredData.length;

          if (!options.agent && !options.compact) {
            console.log(
              resultCountHeader(filteredData, parseInt(options.m, 10)),
            );
            console.log();
          }

          if (shouldBePlain) {
            const mappedResults = toTextResults(filteredData);
            const output = formatTextResults(
              mappedResults,
              pattern,
              projectRootForServer,
              {
                isPlain: true,
                compact: options.compact,
                content: options.content,
                perFile: parseInt(options.perFile, 10),
                showScores: options.scores,
              },
            );
            console.log(output);
          } else {
            const { formatResults } = await import("../lib/output/formatter");
            const output = formatResults(filteredData, projectRootForServer, {
              content: options.content,
            });
            console.log(output);
          }

          return; // EXIT successful server search
        }
      } catch (e) {
        if (process.env.DEBUG) {
          console.error(
            "[search] server request failed, falling back to local:",
            e,
          );
        }
      }
    }

    try {
      await ensureSetup();
      const searchRoot = exec_path ? path.resolve(exec_path) : root;
      const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
      const paths = ensureProjectPaths(projectRoot);

      // Propagate project root to worker processes
      process.env.GMAX_PROJECT_ROOT = projectRoot;

      // Check if project is registered
      const checkRoot = options.root
        ? findProjectRoot(path.resolve(options.root)) ?? path.resolve(options.root)
        : projectRoot;
      const project = getProject(checkRoot);
      if (!project) {
        console.error(
          `This project hasn't been added to gmax yet.\n\nRun: gmax add ${checkRoot}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (project.status === "pending") {
        console.warn(
          "This project is still being indexed. Results may be incomplete.\n",
        );
      }

      vectorDb = new VectorDB(paths.lancedbDir);

      // Check for active indexing lock and warn if present
      if (!options.agent && isLocked(paths.dataDir)) {
        console.warn(
          "⚠️  Warning: Indexing in progress... search results may be incomplete.",
        );
      }

      const hasRows = await vectorDb.hasAnyRows();
      const needsSync = options.sync || !hasRows;

      if (needsSync) {
        const isTTY = process.stdout.isTTY;
        let abortController: AbortController | undefined;
        let signal: AbortSignal | undefined;

        if (!isTTY) {
          abortController = new AbortController();
          signal = abortController.signal;
          setTimeout(() => {
            abortController?.abort();
          }, 60000); // 60 seconds timeout for non-TTY auto-indexing
        }

        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );

        try {
          await ensureGrammars(console.log, { silent: true });
          const result = await initialSync({
            projectRoot,
            dryRun: options.dryRun,
            onProgress,
            signal,
          });

          if (signal?.aborted) {
            spinner.warn(
              `Indexing timed out (${result.processed}/${result.total}). Results may be partial.`,
            );
          }

          if (options.dryRun) {
            spinner.succeed(
              `Dry run complete (${result.processed}/${result.total}) • would have indexed ${result.indexed}`,
            );
            console.log(
              formatDryRunSummary(result, {
                actionDescription: "would have indexed",
                includeTotal: true,
              }),
            );
            return;
          }

          await vectorDb.createFTSIndex();

          // Update registry after sync
          const { readGlobalConfig } = await import("../lib/index/index-config");
          const { registerProject } = await import("../lib/utils/project-registry");
          const gc = readGlobalConfig();
          registerProject({
            root: projectRoot,
            name: path.basename(projectRoot),
            vectorDim: gc.vectorDim,
            modelTier: gc.modelTier,
            embedMode: gc.embedMode,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
          });

          const failedSuffix =
            result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
          spinner.succeed(
            `${options.sync ? "Indexing" : "Initial indexing"} complete (${result.processed}/${result.total}) • indexed ${result.indexed}${failedSuffix}`,
          );
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      }

      // Ensure a watcher is running for live reindexing
      if (!process.env.VITEST && !process.env.NODE_ENV?.includes("test")) {
        const { launchWatcher } = await import("../lib/utils/watcher-launcher");
        const launched = await launchWatcher(projectRoot);
        if (!launched.ok && launched.reason === "spawn-failed") {
          console.warn(`[search] ${launched.message}`);
        }
      }

      const searcher = new Searcher(vectorDb);

      // Use --root or fall back to project root
      const effectiveRoot = options.root
        ? findProjectRoot(path.resolve(options.root)) ?? path.resolve(options.root)
        : projectRoot;
      const searchPathPrefix = exec_path
        ? path.resolve(exec_path)
        : effectiveRoot;
      const pathFilter = searchPathPrefix.endsWith("/")
        ? searchPathPrefix
        : `${searchPathPrefix}/`;

      // Build filters from CLI options
      const searchFilters: Record<string, string> = {};
      if (options.file) searchFilters.file = options.file;
      if (options.exclude) searchFilters.exclude = options.exclude;
      if (options.lang) searchFilters.language = options.lang;
      if (options.role) searchFilters.role = options.role;

      const searchResult = await searcher.search(
        pattern,
        parseInt(options.m, 10),
        { rerank: true },
        Object.keys(searchFilters).length > 0 ? searchFilters : undefined,
        pathFilter,
      );

      if (!options.agent && searchResult.warnings?.length) {
        for (const w of searchResult.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }

      let filteredData = searchResult.data.filter(
        (r) => typeof r.score !== "number" || r.score >= minScore,
      );

      // Post-filter by symbol name regex
      if (options.name) {
        try {
          const regex = new RegExp(options.name, "i");
          filteredData = filteredData.filter((r) => {
            const defs = Array.isArray(r.defined_symbols)
              ? r.defined_symbols
              : [];
            return defs.some((d: string) => regex.test(d));
          });
        } catch {
          // Invalid regex — skip
        }
      }

      // Build import cache when --imports is requested
      const importCache = new Map<string, string>();
      const getImportsForFile = (absPath: string): string => {
        if (!options.imports || !absPath) return "";
        if (!importCache.has(absPath)) {
          importCache.set(absPath, extractImports(absPath));
        }
        return importCache.get(absPath) ?? "";
      };

      // Agent mode: ultra-compact one-line-per-result output
      _searchResultCount = filteredData.length;
      if (options.agent) {
        if (!filteredData.length) {
          console.log("(none)");
          process.exitCode = 1;
        } else {
          // In agent mode, print imports header per file
          const seenImportFiles = new Set<string>();
          for (const r of filteredData) {
            const absP = (r as any).path ?? (r as any).metadata?.path ?? "";
            const relPath = absP.startsWith(effectiveRoot)
              ? absP.slice(effectiveRoot.length + 1)
              : absP;
            const startLine = Math.max(
              1,
              ((r as any).startLine ??
                (r as any).start_line ??
                (r as any).generated_metadata?.start_line ??
                0) + 1,
            );
            const defs = Array.isArray((r as any).defined_symbols)
              ? (r as any).defined_symbols
              : [];
            const symbol = defs[0] || "";
            const role = ((r as any).role ?? "")
              .slice(0, 4)
              .toUpperCase();
            let hint = "";
            if ((r as any).summary) {
              hint = ` — ${(r as any).summary}`;
            } else {
              // Extract first meaningful signature line from content
              const raw = (r as any).content ?? (r as any).text ?? "";
              const lines = raw.split("\n");
              for (const line of lines) {
                const trimmed = line.trim();
                // Skip empty, comments, imports, braces, and mid-line fragments
                if (!trimmed || trimmed.length < 5) continue;
                if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
                if (trimmed.startsWith("import ") || trimmed.startsWith("#") || trimmed.startsWith("File:")) continue;
                if (trimmed === "{" || trimmed === "}") continue;
                // Skip lines that look like continuations (start with punctuation, closing braces, or spread)
                if (/^[.),;:}\]|&(+`'"!~]/.test(trimmed)) continue;
                if (trimmed.startsWith("} ") || trimmed.startsWith("- ") || trimmed.startsWith("...")) continue;
                // Skip lines that look like mid-expression fragments (no keyword/declaration prefix)
                if (/^[a-z]/.test(trimmed) && !/^(export|function|class|interface|type|const|let|var|async|return|if|for|while|switch|enum|struct|pub |fn |def |impl |mod |use )/.test(trimmed)) continue;
                hint = ` — ${trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed}`;
                break;
              }
            }
            // Print file imports once per file when --imports is used
            if (options.imports && absP && !seenImportFiles.has(absP)) {
              seenImportFiles.add(absP);
              const imports = getImportsForFile(absP);
              if (imports) {
                console.log(`[imports ${relPath}] ${imports.split("\n").join(" | ")}`);
              }
            }
            const sym = symbol ? ` ${symbol}` : "";
            const rl = role ? ` [${role}]` : "";
            console.log(`${relPath}:${startLine}${sym}${rl}${hint}`);
          }
        }

        // Agent trace (compact)
        if (options.symbol && vectorDb && filteredData.length > 0) {
          try {
            const { GraphBuilder } = await import(
              "../lib/graph/graph-builder"
            );
            const builder = new GraphBuilder(vectorDb, effectiveRoot);
            const graph = await builder.buildGraphMultiHop(pattern, 1);
            if (graph.center) {
              console.log("---");
              for (const t of graph.callerTree) {
                const rel = t.node.file.startsWith(effectiveRoot)
                  ? t.node.file.slice(effectiveRoot.length + 1)
                  : t.node.file;
                console.log(
                  `<- ${t.node.symbol} ${rel}:${t.node.line + 1}`,
                );
              }
              for (const c of graph.callees.slice(0, 10)) {
                if (c.file) {
                  const rel = c.file.startsWith(effectiveRoot)
                    ? c.file.slice(effectiveRoot.length + 1)
                    : c.file;
                  console.log(`-> ${c.symbol} ${rel}:${c.line + 1}`);
                }
              }
            }
          } catch {}
        }
        return;
      }

      if (options.skeleton) {
        await outputSkeletons(
          filteredData,
          projectRoot,
          parseInt(options.m, 10),
          vectorDb,
        );
        return;
      }

      if (!filteredData.length) {
        console.log("No matches found.");
        console.log(
          "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
        );
        process.exitCode = 1;
        return;
      }

      if (options.compact) {
        const compactHits = toCompactHits(filteredData);
        console.log(
          formatCompactTable(compactHits, projectRoot, pattern, {
            isTTY: !!process.stdout.isTTY,
            plain: !!options.plain,
          }),
        );
        return;
      }

      _searchResultCount = filteredData.length;
      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      if (!options.agent && !options.compact) {
        console.log(
          resultCountHeader(filteredData, parseInt(options.m, 10)),
        );
        console.log();
      }

      // Print imports per unique file before results when --imports is used
      if (options.imports) {
        const seenFiles = new Set<string>();
        for (const r of filteredData) {
          const absP = (r as any).path ?? (r as any).metadata?.path ?? "";
          if (absP && !seenFiles.has(absP)) {
            seenFiles.add(absP);
            const imports = getImportsForFile(absP);
            if (imports) {
              const relP = absP.startsWith(effectiveRoot)
                ? absP.slice(effectiveRoot.length + 1)
                : absP;
              console.log(`--- imports: ${relP} ---\n${imports}\n`);
            }
          }
        }
      }

      if (shouldBePlain) {
        const mappedResults = toTextResults(filteredData);
        const output = formatTextResults(mappedResults, pattern, projectRoot, {
          isPlain: true,
          compact: options.compact,
          content: options.content,
          perFile: parseInt(options.perFile, 10),
          showScores: options.scores,
        });
        console.log(output);
      } else {
        // Use new holographic formatter for TTY
        const { formatResults } = await import("../lib/output/formatter");
        const output = formatResults(filteredData, projectRoot, {
          content: options.content,
        });
        console.log(output);
      }

      // Symbol mode: append call graph
      if (options.symbol && vectorDb) {
        try {
          const { GraphBuilder } = await import(
            "../lib/graph/graph-builder"
          );
          const builder = new GraphBuilder(vectorDb, effectiveRoot);
          const graph = await builder.buildGraphMultiHop(pattern, 1);
          if (graph.center) {
            const lines: string[] = ["\n--- Call graph ---"];
            const centerRel = path.relative(
              effectiveRoot,
              graph.center.file,
            );
            lines.push(
              `${graph.center.symbol} [${graph.center.role}] ${centerRel}:${graph.center.line + 1}`,
            );
            if (graph.importers.length > 0) {
              const filtered = graph.importers.filter(
                (p) => p !== graph.center!.file,
              );
              if (filtered.length > 0) {
                lines.push("Imported by:");
                for (const imp of filtered.slice(0, 10)) {
                  lines.push(
                    `  ${path.relative(effectiveRoot, imp)}`,
                  );
                }
              }
            }
            if (graph.callerTree.length > 0) {
              lines.push("Callers:");
              for (const t of graph.callerTree) {
                lines.push(
                  `  <- ${t.node.symbol} ${path.relative(effectiveRoot, t.node.file)}:${t.node.line + 1}`,
                );
              }
            }
            if (graph.callees.length > 0) {
              lines.push("Calls:");
              for (const c of graph.callees.slice(0, 15)) {
                if (c.file) {
                  lines.push(
                    `  -> ${c.symbol} ${path.relative(effectiveRoot, c.file)}:${c.line + 1}`,
                  );
                } else {
                  lines.push(`  -> ${c.symbol} (not indexed)`);
                }
              }
            }
            console.log(lines.join("\n"));
          }
        } catch {
          // Trace failed — skip silently
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      _searchError = message;
      console.error("Search failed:", message);
      process.exitCode = 1;
    } finally {
      // Best-effort query logging
      try {
        const { logQuery } = await import("../lib/utils/query-log");
        logQuery({
          ts: new Date().toISOString(),
          source: "cli",
          tool: "search",
          query: pattern,
          project: findProjectRoot(root) ?? root,
          results: _searchResultCount,
          ms: Date.now() - _searchStartMs,
          error: _searchError,
        });
      } catch {}
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });

import { Command } from "commander";
import { scopeToWire, withLocalStore } from "../lib/daemon/rows-handler";
import { runSimilar, type SimilarResult } from "../lib/daemon/vector-handler";
import {
  fileNotFoundLines,
  symbolNotFoundLines,
} from "../lib/utils/agent-errors";
import { sendDaemonCommand } from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { resolveContainedPath } from "../lib/utils/path-containment";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import {
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";

export const similar = new Command("similar")
  .description("Find semantically similar code to a symbol or file")
  .argument("<target>", "Symbol name or file path")
  .option("-m, --max-count <n>", "Max results (default 5)", "5")
  .option("--threshold <score>", "Min similarity 0-1 (default 0)")
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
  .action(async (target, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.maxCount || "5", 10), 1),
      25,
    );
    const threshold = Number.parseFloat(opts.threshold || "0") || 0;

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);

      const isFile =
        target.includes("/") || (target.includes(".") && !target.includes(" "));
      // Resolved here, not daemon-side: verifyExistingTarget looks at this
      // process's filesystem, and a path outside the project must fail with the
      // containment error the user expects before anything reaches the store.
      const absPath = isFile
        ? resolveContainedPath(projectRoot, target, {
            verifyExistingTarget: true,
          })
        : undefined;

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      // The source chunk's 384-float vector never leaves the store: the daemon
      // looks it up, runs the vector search, and returns the ranked chunks.
      const result = await withStoreRead<SimilarResult>("similar", {
        daemon: () =>
          sendDaemonCommand(
            {
              cmd: "vector.similar",
              projectRoot,
              absPath,
              symbol: isFile ? undefined : target,
              scope: scopeToWire(scope),
              limit,
              threshold,
            },
            { timeoutMs: 60_000 },
          ),
        render: (resp) => resp as unknown as SimilarResult,
        inProcess: () =>
          withLocalStore(paths.lancedbDir, (deps) =>
            runSimilar(deps, {
              projectRoot,
              absPath,
              symbol: isFile ? undefined : target,
              scope,
              limit,
              threshold,
            }),
          ),
        fallbackOnUnknownVerb: true,
      });

      if (result.status === "not-found") {
        console.log(
          (isFile
            ? fileNotFoundLines(target, { agent: opts.agent })
            : symbolNotFoundLines(target, { agent: opts.agent })
          ).join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      if (result.status === "no-vector") {
        console.log("Source chunk has no embedding vector.");
        process.exitCode = 1;
        return;
      }

      const filtered = result.results;
      if (filtered.length === 0) {
        console.log(`No similar code found for ${target}.`);
        return;
      }

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.agent) {
        for (const r of filtered.slice(0, limit)) {
          const sym = r.defined_symbols?.[0] ?? "";
          const line = (r.start_line ?? 0) + 1;
          const role = (r.role || "IMPL").slice(0, 4);
          const dist = (r._distance ?? 0).toFixed(3);
          console.log(`${rel(r.path)}:${line}\t${sym}\t[${role}]\td=${dist}`);
        }
      } else {
        console.log(`Code similar to ${target}:\n`);
        for (const r of filtered.slice(0, limit)) {
          const sym = r.defined_symbols?.[0] ?? "";
          const line = (r.start_line ?? 0) + 1;
          const role = r.role || "IMPLEMENTATION";
          const dist = (r._distance ?? 0).toFixed(3);
          console.log(
            `  ${rel(r.path)}:${line}  ${sym}  [${role}]  (distance: ${dist})`,
          );
        }
      }
    } catch (error) {
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Similar search failed:", msg);
        process.exitCode = 1;
      }
    } finally {
      await gracefulExit();
    }
  });

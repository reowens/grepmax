import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import {
  CONFIG,
  DISK_CRITICAL_BYTES,
  DISK_LOW_BYTES,
  describeChunkerGap,
  describeEmbeddingGap,
  describeSchemaDimGap,
  MODEL_IDS,
  MODEL_TIERS,
  PATHS,
  REBUILD_COMMAND,
  schemaDimAgentRow,
} from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import {
  gpuEmbedModelStatus,
  onnxModelStatus,
  summarizerServerStatus,
  summaryCoverageStatus,
} from "../lib/utils/doctor-status";
import { gracefulExit } from "../lib/utils/exit";
import { isMlxModelCached } from "../lib/utils/mlx-hf-cache";
import { isProcessAlive, parseLock, removeLock } from "../lib/utils/lock";
import {
  listProjects,
  registerProject,
  removeProject,
} from "../lib/utils/project-registry";
import { findProjectRoot } from "../lib/utils/project-root";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);
      if (stats.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch {}
  return totalSize;
}

export const doctor = new Command("doctor")
  .description("Check installation health, models, and index status")
  .option(
    "--fix",
    "Auto-fix detected issues (compact, prune, remove stale locks)",
    false,
  )
  .option("--agent", "Compact output for AI agents", false)
  .action(async (opts) => {
    if (!opts.agent) console.log("gmax Doctor\n");

    const root = PATHS.globalRoot;
    const models = PATHS.models;
    const grammars = PATHS.grammars;

    if (!opts.agent) {
      const checkDir = (name: string, p: string) => {
        const exists = fs.existsSync(p);
        const symbol = exists ? "ok" : "MISSING";
        console.log(`${symbol}  ${name}: ${p}`);
      };
      checkDir("Root", root);
      checkDir("Models", models);
      checkDir("Grammars", grammars);
    }

    const globalConfig = readGlobalConfig();
    const tier = MODEL_TIERS[globalConfig.modelTier] ?? MODEL_TIERS.small;
    if (!MODEL_TIERS[globalConfig.modelTier]) {
      console.log(
        `WARN  Unknown model tier '${globalConfig.modelTier}', falling back to 'small'`,
      );
    }
    const embedModel =
      globalConfig.embedMode === "gpu" ? tier.mlxModel : tier.onnxModel;

    if (!opts.agent) {
      console.log(
        `\nEmbed mode: ${globalConfig.embedMode} | Model tier: ${globalConfig.modelTier} (${tier.vectorDim}d)`,
      );
      console.log(`Embed model: ${embedModel}`);
      console.log(`ColBERT model: ${MODEL_IDS.colbert}`);

      // Probe the MLX embed server once, up front: the gpu-mode embed model
      // status is derived from it (the server, not the ONNX models dir, is the
      // source of truth in gpu mode). Reused below for the "MLX Embed" line.
      let embedUp = false;
      let embedError = "";
      try {
        const res = await fetch("http://127.0.0.1:8100/health");
        embedUp = res.ok;
      } catch (err: any) {
        embedError =
          err.code === "ECONNREFUSED"
            ? "connection refused"
            : err.message || String(err);
      }

      // Embed model availability. In gpu mode the model is served by MLX from
      // the pinned HF cache (~/.gmax/hf), never the ONNX models dir — report
      // from the live server / HF cache. In cpu mode it's an ONNX model in
      // ~/.gmax/models. ColBERT is always ONNX in-worker regardless of mode.
      const onnxExists = (id: string) =>
        fs.existsSync(path.join(models, ...id.split("/")));
      const embedStatus =
        globalConfig.embedMode === "gpu"
          ? gpuEmbedModelStatus(
              embedModel,
              { up: embedUp },
              isMlxModelCached(embedModel),
            )
          : onnxModelStatus(embedModel, onnxExists(embedModel));
      const colbertStatus = onnxModelStatus(
        MODEL_IDS.colbert,
        onnxExists(MODEL_IDS.colbert),
      );
      for (const s of [embedStatus, colbertStatus]) {
        console.log(`${s.symbol}  ${s.message}`);
      }

      console.log(`\nLocal Project: ${process.cwd()}`);
      const projectRoot = findProjectRoot(process.cwd());
      if (projectRoot) {
        console.log(`ok  Project root: ${projectRoot}`);
        console.log(`    Centralized index at: ~/.gmax/lancedb/`);
      } else {
        console.log(
          `INFO  No index found in current directory (run 'gmax index' to create one)`,
        );
      }

      // MLX embed server (probed once above).
      console.log(
        `${embedUp ? "ok" : "WARN"}  MLX Embed: ${embedUp ? "running (port 8100)" : `not running${embedError ? ` (${embedError})` : ""}`}`,
      );

      if (embedUp) {
        try {
          const start = Date.now();
          const embedRes = await fetch("http://127.0.0.1:8100/embed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: ["gmax health check"] }),
          });
          const embedData = await embedRes.json();
          const dim = embedData?.vectors?.[0]?.length ?? 0;
          const ms = Date.now() - start;
          const expectedDim = tier.vectorDim || 384;
          if (dim === expectedDim) {
            console.log(`ok  Embedding: working (${dim}d, ${ms}ms)`);
          } else {
            console.log(
              `FAIL  Embedding: wrong dimensions (got ${dim}, expected ${expectedDim})`,
            );
          }
        } catch (err: any) {
          console.log(`FAIL  Embedding: test failed (${err.message || err})`);
        }
      }

      // Check summarizer server. Down is INFO, not WARN — opt-in, respawns on
      // demand, idles out after 10min (see summarizerServerStatus).
      const summarizerUp = await fetch("http://127.0.0.1:8101/health")
        .then((r) => r.ok)
        .catch(() => false);
      const summarizerStatus = summarizerServerStatus(summarizerUp);
      console.log(`${summarizerStatus.symbol}  ${summarizerStatus.message}`);
    }

    // --- Index Health ---
    let needsOptimize = false;
    let staleLock = false;
    const orphanedProjects: string[] = [];

    try {
      const { VectorDB } = await import("../lib/store/vector-db");
      const db = new VectorDB(PATHS.lancedbDir);
      const table = await db.ensureTable();
      const totalChunks = await table.countRows();

      // Physical schema-width check: the shared `chunks` table is fixed-width at
      // creation, so a tier/dim change strands it at the old width and every
      // write throws. This is independent of the per-project registry drift
      // checked below — the table can match the registry yet still be physically
      // stranded — so we surface it as its own line.
      const physicalDim = await db.getSchemaVectorDim();
      const schemaGap = describeSchemaDimGap(
        physicalDim,
        globalConfig.vectorDim,
      );

      // Summary coverage (existing check)
      if (!opts.agent && totalChunks > 0) {
        const withSummary = (
          await table
            .query()
            .where("length(summary) > 5")
            .select(["id"])
            .toArray()
        ).length;
        const coverage = summaryCoverageStatus(withSummary, totalChunks);
        console.log(`${coverage.symbol}  ${coverage.message}`);
      } else if (!opts.agent && totalChunks === 0) {
        console.log("INFO  No indexed chunks yet");
      }

      // Index health checks
      const tableStats = await table.stats();
      const diskSize = getDirectorySize(PATHS.lancedbDir);
      const logicalSize = tableStats.totalBytes;
      const { numFragments, numSmallFragments } = tableStats.fragmentStats;
      const versions = await table.listVersions();

      // Lock status
      const lockPath = path.join(PATHS.globalRoot, "LOCK");
      let lockStatus = "none";
      if (fs.existsSync(lockPath)) {
        const { pid, startedAt } = parseLock(lockPath);
        const alive = isProcessAlive(pid);
        if (alive) {
          lockStatus = `active (PID ${pid})`;
        } else {
          lockStatus = `stale (PID ${pid}${startedAt ? ` @ ${startedAt}` : ""})`;
          staleLock = true;
        }
      }

      // Daemon status
      const { isDaemonRunning } = await import("../lib/utils/daemon-client");
      const daemonUp = await isDaemonRunning();

      // Project registry health
      const projects = listProjects();
      for (const p of projects) {
        if (!fs.existsSync(p.root)) {
          orphanedProjects.push(p.root);
        }
      }

      // Compute warning flags
      const bloatRatio = logicalSize > 0 ? diskSize / logicalSize : 0;
      if (bloatRatio > 2.0) needsOptimize = true;
      if (numSmallFragments > 10) needsOptimize = true;
      if (versions.length > 50) needsOptimize = true;

      // Disk space check
      let availBytes = 0;
      let diskLevel = "ok";
      try {
        const diskStats = fs.statfsSync(PATHS.lancedbDir);
        availBytes = diskStats.bavail * diskStats.bsize;
        diskLevel =
          availBytes < DISK_CRITICAL_BYTES
            ? "CRITICAL"
            : availBytes < DISK_LOW_BYTES
              ? "LOW"
              : "ok";
      } catch {}

      const staleChunkerProjects = projects.filter(
        (p) =>
          p.status === "indexed" &&
          (p.chunkerVersion ?? 1) < CONFIG.CHUNKER_VERSION,
      );

      // Projects whose stored embedding model/dim no longer matches the global
      // config. Visibility only — recovery is a manual `gmax index --reset`
      // (a dim change can't be auto-fixed in the shared fixed-dim table; that's
      // the deferred Phase 1B re-embed work).
      const staleEmbeddingProjects = projects.filter(
        (p) =>
          p.status === "indexed" &&
          describeEmbeddingGap(
            { modelTier: p.modelTier, vectorDim: p.vectorDim },
            {
              modelTier: globalConfig.modelTier,
              vectorDim: globalConfig.vectorDim,
            },
          ) !== null,
      );

      if (opts.agent) {
        const fields = [
          "index_health",
          `rows=${totalChunks}`,
          `logical=${formatSize(logicalSize)}`,
          `disk=${formatSize(diskSize)}`,
          `free=${formatSize(availBytes)}`,
          `disk_pressure=${diskLevel}`,
          `fragments=${numFragments}`,
          `small=${numSmallFragments}`,
          `versions=${versions.length}`,
          `lock=${lockStatus.split(" ")[0]}`,
          `daemon=${daemonUp ? "running" : "stopped"}`,
          `orphaned=${orphanedProjects.length}`,
          `stale_chunker=${staleChunkerProjects.length}`,
          `stale_embedding=${staleEmbeddingProjects.length}`,
          `schema_dim=${physicalDim ?? "none"}`,
          `schema_dim_ok=${schemaGap ? "false" : "true"}`,
        ];
        console.log(fields.join("\t"));
        if (schemaGap) {
          console.log(schemaDimAgentRow(schemaGap));
        }
        for (const p of staleChunkerProjects) {
          const gap = describeChunkerGap(p.chunkerVersion);
          if (!gap) continue;
          console.log(
            [
              "stale_chunker_project",
              `name=${p.name || path.basename(p.root)}`,
              `indexed_v=${gap.fromVersion}`,
              `current_v=${gap.toVersion}`,
              `severity=${gap.severity}`,
              `note=${gap.notes.join("; ")}`,
              `fix=gmax index --reset (in ${p.root})`,
            ].join("\t"),
          );
        }
        for (const p of staleEmbeddingProjects) {
          const gap = describeEmbeddingGap(
            { modelTier: p.modelTier, vectorDim: p.vectorDim },
            {
              modelTier: globalConfig.modelTier,
              vectorDim: globalConfig.vectorDim,
            },
          );
          if (!gap) continue;
          console.log(
            [
              "stale_embedding_project",
              `name=${p.name || path.basename(p.root)}`,
              `indexed_model=${gap.fromModel}`,
              `current_model=${gap.toModel}`,
              `indexed_dim=${gap.fromDim}`,
              `current_dim=${gap.toDim}`,
              `dim_changed=${gap.dimChanged}`,
              `severity=${gap.severity}`,
              // A dim change can't be fixed by a per-project reset (the shared
              // table is fixed-width) — point at the global rebuild instead.
              `fix=${gap.dimChanged ? REBUILD_COMMAND : `gmax index --reset (in ${p.root})`}`,
            ].join("\t"),
          );
        }
      } else {
        console.log("\nIndex Health\n");

        // Physical schema width — a mismatch means every write throws until a
        // global rebuild (the shared fixed-width table can't be reshaped by a
        // per-project reset). Surfaced first because it's the most severe.
        if (schemaGap) {
          console.log(
            `FAIL  Schema: vector table is ${schemaGap.tableDim}d, config expects ${schemaGap.configDim}d`,
          );
          console.log(
            `       run '${REBUILD_COMMAND}' (drops + reindexes all projects at the new width)`,
          );
        } else if (physicalDim) {
          console.log(`ok  Schema: vector table is ${physicalDim}d`);
        }

        // Disk space
        if (diskLevel !== "ok") {
          console.log(
            `WARN  Disk: ${formatSize(availBytes)} available (${diskLevel})`,
          );
        } else {
          console.log(`ok  Disk: ${formatSize(availBytes)} available`);
        }

        // Storage
        if (bloatRatio > 2.0) {
          console.log(
            `WARN  Storage: ${totalChunks.toLocaleString()} rows, ${formatSize(logicalSize)} logical, ${formatSize(diskSize)} disk (${bloatRatio.toFixed(1)}x — orphaned files)`,
          );
        } else {
          console.log(
            `ok  Storage: ${totalChunks.toLocaleString()} rows, ${formatSize(logicalSize)} logical, ${formatSize(diskSize)} disk`,
          );
        }

        // Fragments
        if (numSmallFragments > 10) {
          console.log(
            `WARN  Fragments: ${numFragments} total, ${numSmallFragments} small — needs compaction`,
          );
        } else {
          console.log(
            `ok  Fragments: ${numFragments} total, ${numSmallFragments} small`,
          );
        }

        // Versions
        if (versions.length > 50) {
          console.log(
            `WARN  Versions: ${versions.length} — pruning recommended`,
          );
        } else {
          console.log(`ok  Versions: ${versions.length}`);
        }

        // Lock
        if (staleLock) {
          console.log(`WARN  Lock: ${lockStatus}`);
        } else if (lockStatus === "none") {
          console.log("ok  Lock: none");
        } else {
          console.log(`ok  Lock: ${lockStatus}`);
        }

        // Daemon
        console.log(
          `${daemonUp ? "ok" : "INFO"}  Daemon: ${daemonUp ? "running" : "not running"}`,
        );

        // Index built by an older chunker — graph metadata fixes need a reindex.
        // Severity (and the WARN/INFO label) is driven by CHUNKER_VERSION_HISTORY:
        // a breaking gap means stale metadata is wrong, an additive gap only
        // means newer edges are missing.
        if (staleChunkerProjects.length > 0) {
          const anyBreaking = staleChunkerProjects.some(
            (p) =>
              describeChunkerGap(p.chunkerVersion)?.severity === "breaking",
          );
          console.log(
            `${anyBreaking ? "WARN" : "INFO"}  Stale chunker: ${staleChunkerProjects.length} project(s) indexed before chunker v${CONFIG.CHUNKER_VERSION} — run 'gmax doctor --fix' to reindex`,
          );
          for (const p of staleChunkerProjects) {
            const gap = describeChunkerGap(p.chunkerVersion);
            if (!gap) continue;
            console.log(
              `       - ${p.name || path.basename(p.root)} (v${gap.fromVersion}→v${gap.toVersion}, ${gap.severity}): ${gap.notes.join(" ")}`,
            );
            console.log(`         run 'gmax index --reset' in ${p.root}`);
          }
        }

        // Index built with a different embedding model/dim than the current
        // config. A dim change is breaking (search scores are invalid until a
        // re-embed); a same-dim model swap is additive. Recovery differs by kind:
        // a same-dim model swap is fixed by a per-project `gmax index --reset`,
        // but a dim change can't be — the shared table is fixed-width, so it
        // needs the global rebuild (see the Schema check above).
        if (staleEmbeddingProjects.length > 0) {
          const gaps = staleEmbeddingProjects.map((p) =>
            describeEmbeddingGap(
              { modelTier: p.modelTier, vectorDim: p.vectorDim },
              {
                modelTier: globalConfig.modelTier,
                vectorDim: globalConfig.vectorDim,
              },
            ),
          );
          const anyBreaking = gaps.some((g) => g?.severity === "breaking");
          const anyDimChange = gaps.some((g) => g?.dimChanged);
          const headerFix = anyDimChange
            ? `run '${REBUILD_COMMAND}' (dim change needs a full rebuild)`
            : "run 'gmax index --reset' per project";
          console.log(
            `${anyBreaking ? "WARN" : "INFO"}  Stale embedding: ${staleEmbeddingProjects.length} project(s) indexed with a different embedding model/dim — ${headerFix}`,
          );
          staleEmbeddingProjects.forEach((p, i) => {
            const gap = gaps[i];
            if (!gap) return;
            const change = gap.dimChanged
              ? `${gap.fromDim}d→${gap.toDim}d`
              : `model ${gap.fromModel}→${gap.toModel}`;
            console.log(
              `       - ${p.name || path.basename(p.root)} (${change}, ${gap.severity})`,
            );
            console.log(
              gap.dimChanged
                ? `         run '${REBUILD_COMMAND}'`
                : `         run 'gmax index --reset' in ${p.root}`,
            );
          });
        }

        // Projects
        if (orphanedProjects.length > 0) {
          console.log(
            `WARN  Orphaned projects: ${orphanedProjects.length} (directories no longer exist)`,
          );
          for (const op of orphanedProjects) {
            console.log(`       - ${op}`);
          }
        } else if (projects.length > 0) {
          console.log(
            `ok  Projects: ${projects.length} registered, all directories exist`,
          );
        }

        // Cache Coherence
        if (projects.length > 0) {
          console.log("\nCache Coherence\n");
          try {
            const { MetaCache } = await import("../lib/store/meta-cache");
            const mc = new MetaCache(PATHS.lmdbPath);

            for (const project of projects.filter(
              (p) => p.status === "indexed",
            )) {
              const prefix = project.root.endsWith("/")
                ? project.root
                : `${project.root}/`;
              const cachedCount = (await mc.getKeysWithPrefix(prefix)).size;
              const vectorCount = await db.countDistinctFilesForPath(prefix);
              if (cachedCount > 0) {
                const pct = Math.round((vectorCount / cachedCount) * 100);
                const status = pct >= 80 ? "ok" : "WARN";
                console.log(
                  `${status}  ${project.name || path.basename(project.root)}: ${vectorCount} indexed / ${cachedCount} cached (${pct}%)`,
                );
              }
            }

            await mc.close();
          } catch {}
        }
      }

      // --fix auto-remediation
      if (opts.fix) {
        if (!opts.agent) console.log("\nAuto-fix\n");

        let fixed = 0;

        if (staleLock) {
          await removeLock(lockPath);
          if (!opts.agent) console.log("ok  Removed stale lock");
          fixed++;
        }

        if (needsOptimize) {
          if (!opts.agent)
            console.log("...  Running optimize (compact + prune)...");
          await db.optimize(3, 0);
          if (!opts.agent) console.log("ok  Optimize complete");
          fixed++;
        }

        if (orphanedProjects.length > 0) {
          for (const op of orphanedProjects) {
            removeProject(op);
          }
          if (!opts.agent)
            console.log(
              `ok  Removed ${orphanedProjects.length} orphaned project(s) from registry`,
            );
          fixed++;
        }

        // Reindex projects whose index predates the current chunker. This is a
        // full `--reset` reindex per project (routed through the daemon), so it
        // can be slow on large repos — unlike the cheap fixes above.
        if (staleChunkerProjects.length > 0) {
          const { ensureDaemonRunning, sendStreamingCommand } = await import(
            "../lib/utils/daemon-client"
          );
          if (!(await ensureDaemonRunning())) {
            if (!opts.agent)
              console.log(
                "WARN  Stale chunker: daemon not running — start it (gmax watch --daemon -b) or run 'gmax index --reset' per project",
              );
          } else {
            for (const p of staleChunkerProjects) {
              const name = p.name || path.basename(p.root);
              if (!opts.agent)
                console.log(`...  Reindexing ${name} (--reset)...`);
              const done = await sendStreamingCommand(
                { cmd: "index", root: p.root, reset: true },
                () => {},
              ).catch((e) => ({ ok: false, error: String(e) }) as const);
              if (done.ok) {
                registerProject({
                  ...p,
                  status: "indexed",
                  chunkerVersion: CONFIG.CHUNKER_VERSION,
                  lastIndexed: new Date().toISOString(),
                  chunkCount: (done.indexed as number) ?? p.chunkCount,
                });
                const chunks = (done.indexed as number) ?? 0;
                if (opts.agent) {
                  console.log(
                    `stale_chunker_reindexed\tname=${name}\tchunks=${chunks}`,
                  );
                } else {
                  console.log(`ok  ${name} reindexed (${chunks} chunks)`);
                }
                fixed++;
              } else if (!opts.agent) {
                console.log(`FAIL  ${name}: reindex failed (${done.error})`);
              }
            }
          }
        }

        if (fixed === 0) {
          if (!opts.agent) console.log("ok  Nothing to fix");
        }
      }

      await db.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.agent) {
        console.log(`index_health\terror=${msg.replace(/\t/g, " ")}`);
      } else {
        console.log(`\nWARN  Could not check index health: ${msg}`);
      }
    }

    if (!opts.agent) {
      console.log(
        `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
      );
    }

    await gracefulExit();
  });

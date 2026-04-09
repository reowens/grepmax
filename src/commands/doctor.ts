import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { DISK_CRITICAL_BYTES, DISK_LOW_BYTES, MODEL_IDS, MODEL_TIERS, PATHS } from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { isProcessAlive, parseLock, removeLock } from "../lib/utils/lock";
import { listProjects, removeProject } from "../lib/utils/project-registry";
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
  .option("--fix", "Auto-fix detected issues (compact, prune, remove stale locks)", false)
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
      console.log(`WARN  Unknown model tier '${globalConfig.modelTier}', falling back to 'small'`);
    }
    const embedModel =
      globalConfig.embedMode === "gpu" ? tier.mlxModel : tier.onnxModel;

    if (!opts.agent) {
      console.log(
        `\nEmbed mode: ${globalConfig.embedMode} | Model tier: ${globalConfig.modelTier} (${tier.vectorDim}d)`,
      );
      console.log(`Embed model: ${embedModel}`);
      console.log(`ColBERT model: ${MODEL_IDS.colbert}`);

      const modelStatuses = [embedModel, MODEL_IDS.colbert].map((id) => {
        const modelPath = path.join(models, ...id.split("/"));
        return { id, path: modelPath, exists: fs.existsSync(modelPath) };
      });

      modelStatuses.forEach(({ id, exists }) => {
        console.log(`${exists ? "ok" : "WARN"}  ${id}: ${exists ? "downloaded" : "will download on first use"}`);
      });

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

      // Check MLX embed server
      let embedUp = false;
      let embedError = "";
      try {
        const res = await fetch("http://127.0.0.1:8100/health");
        embedUp = res.ok;
      } catch (err: any) {
        embedError = err.code === "ECONNREFUSED" ? "connection refused" : (err.message || String(err));
      }
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
            console.log(`FAIL  Embedding: wrong dimensions (got ${dim}, expected ${expectedDim})`);
          }
        } catch (err: any) {
          console.log(`FAIL  Embedding: test failed (${err.message || err})`);
        }
      }

      // Check summarizer server
      const summarizerUp = await fetch("http://127.0.0.1:8101/health")
        .then((r) => r.ok)
        .catch(() => false);
      console.log(
        `${summarizerUp ? "ok" : "WARN"}  Summarizer: ${summarizerUp ? "running (port 8101)" : "not running"}`,
      );
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

      // Summary coverage (existing check)
      if (!opts.agent && totalChunks > 0) {
        const withSummary = (
          await table
            .query()
            .where("length(summary) > 5")
            .select(["id"])
            .toArray()
        ).length;
        const pct = Math.round((withSummary / totalChunks) * 100);
        const symbol = pct >= 90 ? "ok" : pct > 0 ? "WARN" : "FAIL";
        console.log(
          `${symbol}  Summary coverage: ${withSummary}/${totalChunks} (${pct}%)`,
        );
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
        diskLevel = availBytes < DISK_CRITICAL_BYTES ? "CRITICAL" : availBytes < DISK_LOW_BYTES ? "LOW" : "ok";
      } catch {}

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
        ];
        console.log(fields.join("\t"));
      } else {
        console.log("\nIndex Health\n");

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

            for (const project of projects.filter(p => p.status === "indexed")) {
              const prefix = project.root.endsWith("/") ? project.root : `${project.root}/`;
              const cachedCount = (await mc.getKeysWithPrefix(prefix)).size;
              const vectorCount = await db.countDistinctFilesForPath(prefix);
              if (cachedCount > 0) {
                const pct = Math.round((vectorCount / cachedCount) * 100);
                const status = pct >= 80 ? "ok" : "WARN";
                console.log(`${status}  ${project.name || path.basename(project.root)}: ${vectorCount} indexed / ${cachedCount} cached (${pct}%)`);
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
          if (!opts.agent) console.log("...  Running optimize (compact + prune)...");
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

        if (fixed === 0) {
          if (!opts.agent) console.log("ok  Nothing to fix");
        }
      }

      await db.close();
    } catch {
      if (opts.agent) {
        console.log("index_health\terror=could_not_check");
      } else {
        console.log("\nWARN  Could not check index health");
      }
    }

    if (!opts.agent) {
      console.log(
        `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
      );
    }

    await gracefulExit();
  });

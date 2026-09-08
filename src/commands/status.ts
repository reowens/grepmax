import * as os from "node:os";
import { Command } from "commander";
import { PATHS } from "../config";
import {
  countLegacyEmbeddingProjects,
  formatLegacyEmbeddingNotice,
  projectEmbeddingStatus,
} from "../lib/index/embedding-status";
import { readGlobalConfig } from "../lib/index/index-config";
import { sendDaemonCommand } from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { pathStartsWith } from "../lib/utils/filter-builder";
import { isLocked } from "../lib/utils/lock";
import type { ProjectEntry } from "../lib/utils/project-registry";
import { listProjects } from "../lib/utils/project-registry";
import { findProjectRoot } from "../lib/utils/project-root";
import {
  classifyLeaseError,
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";
import type { WatcherInfo } from "../lib/utils/watcher-store";
import { getWatcherForProject, listWatchers } from "../lib/utils/watcher-store";

/**
 * What `status` needs from the store, however it was obtained: which projects
 * are being watched, and how many chunks each holds right now.
 */
interface StatusView {
  watchers: Map<string, Pick<WatcherInfo, "status">>;
  chunkCounts: Map<string, number>;
}

/**
 * Ask the daemon first. Both verbs already exist, so this works against an
 * unrestarted daemon, and it is what makes `status` survive a sandbox that
 * denies writes to ~/.gmax: `listWatchers()` opens LMDB, which needs its lock
 * file even to read, and died with "Attempting to setup locks" before the
 * command ever reached the store.
 *
 * The in-process branch is entered only when nothing is listening on the
 * socket. A lease/LMDB denial there is converted by withStoreRead into the
 * one-line filesystem hint.
 */
async function loadStatusView(projects: ProjectEntry[]): Promise<StatusView> {
  return withStoreRead<StatusView>("status", {
    daemon: () => sendDaemonCommand({ cmd: "status" }),
    render: async (resp) => {
      const watchers = new Map<string, Pick<WatcherInfo, "status">>();
      const entries = Array.isArray(resp.projects) ? resp.projects : [];
      for (const entry of entries as Array<{ root?: unknown }>) {
        if (entry && typeof entry.root === "string") {
          watchers.set(entry.root, { status: "watching" });
        }
      }
      // One project-stats call per project. A failure here is not fatal: the
      // renderer falls back to the registry's cached chunkCount, exactly as
      // the in-process path does when the LanceDB query fails.
      const chunkCounts = new Map<string, number>();
      for (const project of projects) {
        const stats = await sendDaemonCommand(
          { cmd: "project-stats", root: project.root },
          { timeoutMs: 30_000 },
        );
        if (stats.ok && typeof stats.chunks === "number") {
          chunkCounts.set(project.root, stats.chunks);
        }
      }
      return { watchers, chunkCounts };
    },
    inProcess: async () => {
      listWatchers(); // cleans stale entries as side effect
      const watchers = new Map<string, Pick<WatcherInfo, "status">>();
      for (const project of projects) {
        const watcher = getWatcherForProject(project.root);
        if (watcher) watchers.set(project.root, { status: watcher.status });
      }

      const chunkCounts = new Map<string, number>();
      try {
        const { VectorDB } = await import("../lib/store/vector-db");
        const db = new VectorDB(PATHS.lancedbDir);
        const table = await db.ensureTable();
        for (const project of projects) {
          const prefix = project.root.endsWith("/")
            ? project.root
            : `${project.root}/`;
          const rows = await table
            .query()
            .select(["id"])
            .where(pathStartsWith(prefix))
            .toArray();
          chunkCounts.set(project.root, rows.length);
        }
        await db.close();
      } catch (err) {
        // A sandbox denial is not "the query failed" — let it surface as the
        // one-line refusal instead of silently degrading to cached counts.
        if (classifyLeaseError(err) === "sandboxed") throw err;
        console.warn(
          `[status] Failed to query LanceDB for live chunk counts, using cached counts`,
        );
      }
      return { watchers, chunkCounts };
    },
  });
}

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function formatAge(isoDate: string): string {
  if (!isoDate) return "never";
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function formatChunks(n?: number): string {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export const status = new Command("status")
  .description("Show gmax index status for all projects")
  .option("--agent", "Compact output for AI agents", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax status              Show status of all indexed projects
`,
  )
  .action(async (opts) => {
    const globalConfig = readGlobalConfig();
    const projects = listProjects();
    const indexing = isLocked(PATHS.globalRoot);
    const currentRoot = findProjectRoot(process.cwd());

    // Resolved before the header so a sandbox refusal prints one clean line.
    let view: StatusView;
    try {
      view = await loadStatusView(projects);
    } catch (err) {
      if (reportStoreAccessRefusal(err)) {
        await gracefulExit(2);
        return;
      }
      throw err;
    }
    const { watchers, chunkCounts } = view;

    if (!opts.agent) {
      // Header
      console.log(
        `\n${style.bold("gmax")} · ${globalConfig.modelTier} (${globalConfig.vectorDim}d, ${globalConfig.embedMode})${indexing ? style.yellow(" · indexing...") : ""}`,
      );
    }

    if (projects.length === 0) {
      if (opts.agent) {
        console.log("(none)");
      } else {
        console.log(
          `\nNo projects added yet. Run ${style.cyan("gmax add")} to get started.\n`,
        );
      }
      await gracefulExit();
      return;
    }

    if (opts.agent) {
      for (const project of projects) {
        const watcher = watchers.get(project.root);
        const projectStatus = project.status ?? "indexed";
        let st: string;
        if (projectStatus === "pending") st = "pending";
        else if (projectStatus === "error") st = "error";
        else if (watcher?.status === "syncing") st = "indexing";
        else if (watcher) st = "watching";
        else st = "idle";
        const isCurrent = project.root === currentRoot;
        const count = chunkCounts.get(project.root) ?? project.chunkCount;
        const identity = projectEmbeddingStatus(project, globalConfig);
        console.log(
          `${project.name}\t${formatChunks(count)}\t${formatAge(project.lastIndexed)}\t${st}\tembedding=${identity.state}${isCurrent ? "\tcurrent" : ""}`,
        );
      }
      const legacyNotice = formatLegacyEmbeddingNotice(
        countLegacyEmbeddingProjects(projects, globalConfig),
        { agent: true },
      );
      if (legacyNotice) console.log(legacyNotice);
      await gracefulExit();
      return;
    }

    // Column widths
    const nameWidth = Math.max(10, ...projects.map((p) => p.name.length));

    console.log();
    for (const project of projects) {
      const isCurrent = project.root === currentRoot;
      const watcher = watchers.get(project.root);

      // Status column
      let statusStr: string;
      const projectStatus = project.status ?? "indexed";
      if (projectStatus === "pending") {
        statusStr = style.yellow("pending");
      } else if (projectStatus === "error") {
        statusStr = style.red("error");
      } else if (watcher?.status === "syncing") {
        statusStr = style.yellow("indexing");
      } else if (watcher) {
        statusStr = style.green("watching");
      } else {
        statusStr = style.dim("idle");
      }

      // Chunks column
      const count = chunkCounts.get(project.root) ?? project.chunkCount;
      const chunks = `${formatChunks(count)} chunks`;

      // Age column
      const age = formatAge(project.lastIndexed);
      const embedding = projectEmbeddingStatus(project, globalConfig).state;

      // Current marker
      const marker = isCurrent ? style.cyan(" ←") : "";

      const name = project.name.padEnd(nameWidth);
      console.log(
        `  ${name}  ${chunks.padEnd(12)}  ${age.padEnd(10)}  ${statusStr}  embedding:${embedding}${marker}`,
      );
    }

    const legacyNotice = formatLegacyEmbeddingNotice(
      countLegacyEmbeddingProjects(projects, globalConfig),
    );
    if (legacyNotice) console.log(`\n${style.yellow(legacyNotice)}`);

    if (currentRoot) {
      console.log(`\n${style.dim("Current")}: ${shortenPath(currentRoot)}`);
    }

    console.log();
    await gracefulExit();
  });

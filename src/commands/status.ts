import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { Command } from "commander";
import {
  PATHS,
  resolveWorkerThreads,
  type WorkerThreadsSource,
} from "../config";
import {
  countLegacyEmbeddingProjects,
  formatLegacyEmbeddingNotice,
  projectEmbeddingStatus,
} from "../lib/index/embedding-status";
import { type GlobalConfig, readGlobalConfig } from "../lib/index/index-config";
import {
  formatIndexStateFooter,
  formatWatchQueue,
  type IndexState,
} from "../lib/output/index-state-footer";
import type { CompactionResult } from "../lib/store/compaction-result";
import { daemonStartDeniedReason } from "../lib/utils/autostart";
import { sendDaemonCommand } from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { pathStartsWith } from "../lib/utils/filter-builder";
import { isLocked } from "../lib/utils/lock";
import type { ProjectEntry } from "../lib/utils/project-registry";
import { listProjects } from "../lib/utils/project-registry";
import { findProjectRoot } from "../lib/utils/project-root";
import { QUERY_EXECUTION_OPTIONS } from "../lib/utils/query-timeout";
import type { ResourceSnapshot } from "../lib/utils/resource-snapshot";
import {
  classifyLeaseError,
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";
import {
  type StoreInventory,
  storeInventory,
} from "../lib/utils/store-context";
import type { WatcherInfo } from "../lib/utils/watcher-store";
import { getWatcherForProject, listWatchers } from "../lib/utils/watcher-store";

/**
 * What `status` needs from the store, however it was obtained: which projects
 * are being watched, and how many chunks each holds right now.
 */
export interface StatusView {
  watchers: Map<string, Pick<WatcherInfo, "status">>;
  chunkCounts: Map<string, number>;
  health?: Map<string, IndexState>;
  /** Present only when the daemon answered. */
  daemon?: {
    pid: number | null;
    uptimeSec: number | null;
    workers: number | null;
    workerThreads: number | null;
    service?: { mode: "active" | "paused"; reason?: string };
    resources?: ResourceSnapshot | null;
    compaction?: CompactionResult | null;
  };
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
      const health = new Map<string, IndexState>();
      for (const entry of entries as Array<{
        root?: unknown;
        status?: WatcherInfo["status"];
        indexState?: IndexState;
      }>) {
        if (entry && typeof entry.root === "string") {
          watchers.set(entry.root, { status: entry.status ?? "watching" });
          if (entry.indexState) health.set(entry.root, entry.indexState);
        }
      }
      // One project-stats call per project. A failure here is not fatal: the
      // renderer falls back to the registry's cached chunkCount, exactly as
      // the in-process path does when the LanceDB query fails.
      const chunkCounts = new Map<string, number>();
      for (const project of projects) {
        if ((resp.service as { mode?: string } | undefined)?.mode === "paused")
          break;
        const stats = await sendDaemonCommand(
          { cmd: "project-stats", root: project.root },
          { timeoutMs: 30_000 },
        );
        if (stats.ok && typeof stats.chunks === "number") {
          chunkCounts.set(project.root, stats.chunks);
        }
      }
      const daemon = {
        ...(resp.compaction !== undefined
          ? { compaction: resp.compaction as CompactionResult | null }
          : {}),
        ...(resp.resources !== undefined
          ? { resources: resp.resources as ResourceSnapshot | null }
          : {}),
        ...(resp.service
          ? {
              service: resp.service as {
                mode: "active" | "paused";
                reason?: string;
              },
            }
          : {}),
        pid: typeof resp.pid === "number" ? resp.pid : null,
        uptimeSec: typeof resp.uptime === "number" ? resp.uptime : null,
        // Older daemons do not report these.
        workers: typeof resp.workers === "number" ? resp.workers : null,
        workerThreads:
          resp.workerThreads &&
          typeof (resp.workerThreads as { value?: unknown }).value === "number"
            ? (resp.workerThreads as { value: number }).value
            : null,
      };
      return { watchers, chunkCounts, daemon, health };
    },
    inProcess: async () => {
      listWatchers(); // cleans stale entries as side effect
      const watchers = new Map<string, Pick<WatcherInfo, "status">>();
      for (const project of projects) {
        const watcher = getWatcherForProject(project.root);
        if (watcher) watchers.set(project.root, { status: watcher.status });
      }

      const chunkCounts = new Map<string, number>();
      let db: import("../lib/store/vector-db").VectorDB | undefined;
      try {
        const { VectorDB } = await import("../lib/store/vector-db");
        db = new VectorDB(PATHS.lancedbDir);
        const table = await db.ensureTable();
        for (const project of projects) {
          const prefix = project.root.endsWith("/")
            ? project.root
            : `${project.root}/`;
          const rows = await table
            .query()
            .select(["id"])
            .where(pathStartsWith(prefix))
            .toArray(QUERY_EXECUTION_OPTIONS);
          chunkCounts.set(project.root, rows.length);
        }
      } catch (err) {
        // A sandbox denial is not "the query failed" — let it surface as the
        // one-line refusal instead of silently degrading to cached counts.
        if (classifyLeaseError(err) === "sandboxed") throw err;
        console.warn(
          `[status] Failed to query LanceDB for live chunk counts, using cached counts`,
        );
      } finally {
        await db?.close();
      }
      return { watchers, chunkCounts };
    },
  });
}

/** State shown per project; shared by --agent and --json. */
function projectState(
  project: ProjectEntry,
  watcher: Pick<WatcherInfo, "status"> | undefined,
): string {
  const projectStatus = project.status ?? "indexed";
  if (projectStatus === "pending") return "pending";
  if (projectStatus === "error") return "error";
  if (watcher?.status === "degraded") return "degraded";
  if (watcher?.status === "syncing") return "indexing";
  if (watcher) return "watching";
  return "idle";
}

/**
 * Worker processes under the daemon, from the process table. Used only when
 * the daemon is too old to report its pool size.
 */
function countWorkerProcesses(daemonPid: number): number | null {
  try {
    const out = execFileSync("ps", ["-axo", "ppid=,command="], {
      encoding: "utf8",
      timeout: 2000,
    });
    let n = 0;
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)/);
      if (m && Number(m[1]) === daemonPid && m[2] === "gmax-worker") n++;
    }
    return n;
  } catch {
    return null;
  }
}

function toMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export interface StatusJson {
  stores?: StoreInventory[];
  daemon: {
    running: boolean;
    startupBlockedReason?: string;
    pid: number | null;
    since: number | null;
    workerThreads: number | null;
    service?: { mode: "active" | "paused"; reason?: string };
    resources?: ResourceSnapshot | null;
    compaction?: CompactionResult | null;
  };
  settings: {
    embedMode: "cpu" | "gpu";
    modelTier: string;
    vectorDim: number;
    queryLog: boolean;
    workerThreads: { value: number; source: WorkerThreadsSource };
  };
  workersRunning: number | null;
  indexing: boolean;
  projects: Array<{
    name: string;
    root: string;
    chunks: number;
    indexedAt: number | null;
    state: string;
    embedding: string;
    health?: IndexState;
  }>;
  at: number;
}

export function buildStatusJson(input: {
  stores?: StoreInventory[];
  view: StatusView;
  projects: ProjectEntry[];
  globalConfig: GlobalConfig;
  indexing: boolean;
  startupBlockedReason?: string | null;
  workerThreads: { value: number; source: WorkerThreadsSource };
  now?: number;
  countWorkers?: (daemonPid: number) => number | null;
}): StatusJson {
  const now = input.now ?? Date.now();
  const { view, globalConfig } = input;
  const d = view.daemon;
  let workersRunning: number | null = null;
  if (d) {
    workersRunning =
      d.workers ??
      (d.pid !== null
        ? (input.countWorkers ?? countWorkerProcesses)(d.pid)
        : null);
  }
  return {
    ...(input.stores ? { stores: input.stores } : {}),
    daemon: {
      running: d !== undefined,
      ...(input.startupBlockedReason != null
        ? { startupBlockedReason: input.startupBlockedReason }
        : {}),
      pid: d?.pid ?? null,
      since: d?.uptimeSec != null ? now - d.uptimeSec * 1000 : null,
      workerThreads: d?.workerThreads ?? null,
      ...(d?.service ? { service: d.service } : {}),
      ...(d?.resources !== undefined ? { resources: d.resources } : {}),
      ...(d?.compaction !== undefined ? { compaction: d.compaction } : {}),
    },
    settings: {
      embedMode: globalConfig.embedMode,
      modelTier: globalConfig.modelTier,
      vectorDim: globalConfig.vectorDim,
      queryLog: globalConfig.queryLog === true,
      workerThreads: input.workerThreads,
    },
    workersRunning,
    indexing: input.indexing,
    projects: input.projects.map((project) => ({
      name: project.name,
      root: project.root,
      chunks: view.chunkCounts.get(project.root) ?? project.chunkCount ?? 0,
      indexedAt: toMs(project.lastIndexed),
      state: projectState(project, view.watchers.get(project.root)),
      embedding: projectEmbeddingStatus(project, globalConfig).state,
      ...(view.health?.has(project.root)
        ? { health: view.health.get(project.root) }
        : {}),
    })),
    at: now,
  };
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
  .option(
    "--json",
    "Machine-readable status: daemon, settings, projects",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  gmax status              Show status of all indexed projects
  gmax status --json       The same, plus daemon and settings, as JSON
`,
  )
  .action(async (opts) => {
    const globalConfig = readGlobalConfig();
    const projects = listProjects();
    const indexing = isLocked(PATHS.globalRoot);
    const currentRoot = findProjectRoot(process.cwd());
    const stores = storeInventory();

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
    const startupBlockedReason = daemonStartDeniedReason();

    if (opts.json) {
      const json = buildStatusJson({
        stores,
        view,
        projects,
        globalConfig,
        indexing,
        startupBlockedReason,
        workerThreads: resolveWorkerThreads({
          env: process.env.GMAX_WORKER_THREADS,
          configValue: globalConfig.workerThreads,
        }),
      });
      console.log(JSON.stringify(json));
      await gracefulExit();
      return;
    }

    if (!opts.agent) {
      // Header
      console.log(
        `\n${style.bold("gmax")} · ${globalConfig.modelTier} (${globalConfig.vectorDim}d, ${globalConfig.embedMode})${indexing ? style.yellow(" · indexing...") : ""}`,
      );
    }

    if (view.daemon?.service?.mode === "paused") {
      const reason = (view.daemon.service.reason ?? "host pressure").replace(
        /[\r\n\t]/g,
        " ",
      );
      console.log(
        opts.agent
          ? `daemon_service\tmode=paused\treason=${reason}`
          : style.yellow(
              `Bounded reads available; indexing and embeddings paused: ${reason}`,
            ),
      );
    } else if (startupBlockedReason !== null) {
      const reason = startupBlockedReason.replace(/[\r\n\t]/g, " ");
      console.log(
        opts.agent
          ? `daemon_startup\tblocked=true\treason=${reason}`
          : style.red(`Daemon startup blocked: ${reason}`),
      );
    }

    for (const store of stores) {
      if (opts.agent) {
        console.log(
          `store\t${store.home}\t${store.state}\tprefixes=${store.prefixes.join(",")}${store.error ? `\terror=${store.error}` : ""}`,
        );
        for (const project of store.projects)
          console.log(
            `store_project\t${store.home}\t${project.name}\t${project.chunkCount ?? 0}\t${project.status ?? "indexed"}\tcounts=cached`,
          );
      } else {
        console.log(
          `\nStore: ${shortenPath(store.home)} — ${store.state}${store.error ? ` (${store.error})` : ""}`,
        );
        if (store.state === "offline")
          console.log("  Connect the drive to list its projects.");
        for (const project of store.projects)
          console.log(
            `  ${project.name}  ${formatChunks(project.chunkCount)} chunks (cached)  ${project.status ?? "indexed"}`,
          );
      }
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
        const st = projectState(project, watchers.get(project.root));
        const isCurrent = project.root === currentRoot;
        const count = chunkCounts.get(project.root) ?? project.chunkCount;
        const identity = projectEmbeddingStatus(project, globalConfig);
        const queue = view.health?.get(project.root)?.queue;
        console.log(
          `${project.name}\t${formatChunks(count)}\t${formatAge(project.lastIndexed)}\t${st}\tembedding=${identity.state}${isCurrent ? "\tcurrent" : ""}${view.health?.get(project.root) ? `\t${formatIndexStateFooter(view.health.get(project.root), { agent: true }) ?? ""}` : ""}${queue ? `\t${formatWatchQueue(queue)}` : ""}`,
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
      } else if (watcher?.status === "degraded") {
        statusStr = style.red("degraded");
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
      const health = formatIndexStateFooter(view.health?.get(project.root), {
        agent: false,
      });
      if (health) console.log(`    ${health}`);
      const queue = view.health?.get(project.root)?.queue;
      if (queue) console.log(`    queue: ${formatWatchQueue(queue)}`);
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

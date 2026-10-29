import * as path from "node:path";

export interface RepoStatus {
  schemaVersion: 1;
  cwd: string;
  repoRoot: string;
  matchedRoot: string | null;
  indexState: "unknown" | "not_registered" | "indexed" | "pending" | "error" |
    "legacy_unknown" | "metadata_unavailable" | "store_unavailable";
  source: "registry";
  cachedChunks: number | null;
  storeHome: string | null;
  daemon: { state: "unobserved" | "unavailable" | "offline" | "denied" |
    "initializing" | "paused" | "ready" | "legacy_unknown" };
  mcp: "client_catalog_required";
  cliHint: string | null;
}

// Ship one dependency-free implementation with the hooks; plugins/ is already
// part of the npm payload. This adapter supplies types to compiled consumers.
const implementation = require(path.join(
  __dirname, "../../../plugins/grepmax/hooks/repo-status.js",
)) as {
  readRepoStatus(dir?: string): RepoStatus;
  getRepoStatus(dir?: string): Promise<RepoStatus>;
  formatRepoContext(status: RepoStatus): string;
};

export const { readRepoStatus, getRepoStatus, formatRepoContext } = implementation;

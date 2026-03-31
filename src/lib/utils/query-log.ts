import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { readGlobalConfig } from "../index/index-config";

const LOG_PATH = path.join(PATHS.logsDir, "queries.jsonl");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB, then rotate

export interface QueryLogEntry {
  ts: string;
  source: "cli" | "mcp";
  tool: string;
  query?: string;
  symbol?: string;
  project?: string;
  results: number;
  ms: number;
  error?: string;
}

/**
 * Log a query to ~/.gmax/logs/queries.jsonl.
 * Disabled by default. Enable with: gmax config --set queryLog=true
 */
export function logQuery(entry: QueryLogEntry): void {
  try {
    if (!readGlobalConfig().queryLog) return;

    fs.mkdirSync(PATHS.logsDir, { recursive: true });

    // Rotate if too large
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > MAX_SIZE) {
        fs.renameSync(LOG_PATH, `${LOG_PATH}.prev`);
      }
    } catch {}

    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // Never fail — logging is best-effort
  }
}

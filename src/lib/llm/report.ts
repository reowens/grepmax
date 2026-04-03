import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export type Severity = "error" | "warning";
export type FindingCategory =
  | "breaking_change"
  | "logic_error"
  | "security"
  | "resource_leak"
  | "concurrency"
  | "missing_error_handling";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: FindingCategory;
  symbol: string;
  message: string;
  evidence: string[];
  suggestion: string;
}

export interface ReviewEntry {
  commit: string;
  message: string;
  timestamp: string;
  duration_seconds: number;
  findings: Finding[];
  summary: string;
  clean: boolean;
}

export interface ReviewReport {
  session_start: string;
  reviews: ReviewEntry[];
  summary: {
    commits_reviewed: number;
    total_findings: number;
    errors: number;
    warnings: number;
  };
}

export function getReportPath(projectRoot: string): string {
  const hash = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 16);
  return path.join(PATHS.cacheDir, `review-${hash}.json`);
}

function emptyReport(): ReviewReport {
  return {
    session_start: new Date().toISOString(),
    reviews: [],
    summary: { commits_reviewed: 0, total_findings: 0, errors: 0, warnings: 0 },
  };
}

export function readReport(projectRoot: string): ReviewReport | null {
  const p = getReportPath(projectRoot);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as ReviewReport;
  } catch {
    return null;
  }
}

export function appendReview(projectRoot: string, entry: ReviewEntry): void {
  const p = getReportPath(projectRoot);
  const tmp = `${p}.tmp`;

  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const report = readReport(projectRoot) ?? emptyReport();

    report.reviews.push(entry);

    // Recompute summary
    let errors = 0;
    let warnings = 0;
    let total = 0;
    for (const r of report.reviews) {
      for (const f of r.findings) {
        total++;
        if (f.severity === "error") errors++;
        else warnings++;
      }
    }
    report.summary = {
      commits_reviewed: report.reviews.length,
      total_findings: total,
      errors,
      warnings,
    };

    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    // Clean up tmp on failure
    try { fs.unlinkSync(tmp); } catch {}
    console.error(`[review] failed to write report: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function clearReport(projectRoot: string): void {
  try {
    fs.unlinkSync(getReportPath(projectRoot));
  } catch {}
}

export function formatReportText(report: ReviewReport): string {
  const { summary } = report;
  const lines: string[] = [];

  lines.push("=== Review Report ===");
  lines.push(
    `${summary.commits_reviewed} commit(s) reviewed — ${summary.total_findings} finding(s) (${summary.errors} error, ${summary.warnings} warning)`,
  );
  lines.push("");

  for (const rev of report.reviews) {
    lines.push(`--- ${rev.commit} — ${rev.message} (${rev.duration_seconds}s) ---`);

    if (rev.findings.length === 0) {
      lines.push("  clean");
    } else {
      for (const f of rev.findings) {
        const tag = f.severity === "error" ? "ERROR" : "WARN ";
        lines.push(`  ${tag}  ${f.file}:${f.line} [${f.category}]`);
        lines.push(`         ${f.message}`);
        for (const e of f.evidence) {
          lines.push(`         > ${e}`);
        }
        if (f.suggestion) {
          lines.push(`         fix: ${f.suggestion}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

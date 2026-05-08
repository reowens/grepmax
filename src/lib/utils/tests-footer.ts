import { findTests, type TestHit } from "../graph/impact";
import type { VectorDB } from "../store/vector-db";

const FOOTER_TIMEOUT_MS = 1500;
const MAX_SHOWN = 5;

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchTestsForFooter(
  symbol: string,
  vectorDb: VectorDB,
  pathPrefix: string,
  excludePrefixes: string[] | undefined,
): Promise<TestHit[] | null> {
  return withTimeout(
    findTests([symbol], vectorDb, pathPrefix, 1, excludePrefixes),
    FOOTER_TIMEOUT_MS,
  );
}

function relPath(p: string, projectRoot: string): string {
  return p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
}

function hopLabelAgent(hops: number): string {
  if (hops === -1) return "via-import";
  if (hops === 0) return "direct";
  return `${hops}-hop`;
}

function hopLabelHuman(hops: number): string {
  if (hops === -1) return "via import";
  if (hops === 0) return "direct";
  return `${hops} hop${hops > 1 ? "s" : ""}`;
}

export function renderTestsFooterAgent(
  tests: TestHit[],
  projectRoot: string,
): string[] {
  const lines: string[] = [];
  for (const t of tests.slice(0, MAX_SHOWN)) {
    lines.push(
      `t: ${relPath(t.file, projectRoot)}:${t.line + 1}\t${t.symbol}\t${hopLabelAgent(t.hops)}`,
    );
  }
  if (tests.length > MAX_SHOWN) {
    lines.push(`t: ... ${tests.length - MAX_SHOWN} more`);
  }
  return lines;
}

export function renderTestsFooterHuman(
  tests: TestHit[],
  projectRoot: string,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`tests (${tests.length}):`);
  for (const t of tests.slice(0, MAX_SHOWN)) {
    lines.push(
      `  ${t.symbol.padEnd(25)} ${dim(`${relPath(t.file, projectRoot)}:${t.line + 1}`)} ${dim(`(${hopLabelHuman(t.hops)})`)}`,
    );
  }
  if (tests.length > MAX_SHOWN) {
    lines.push(dim(`  ... and ${tests.length - MAX_SHOWN} more`));
  }
  return lines;
}

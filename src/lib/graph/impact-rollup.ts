import * as path from "node:path";
import { type DetailedDependentHit, isTestPath, type TestHit } from "./impact";
import {
  formatViaAgent,
  formatViaHuman,
  groupTestHitsByFile,
  hopLabelAgent,
  hopLabelHuman,
  type TestFileHit,
} from "./test-hits";

export interface ImpactExportRollup {
  symbol: string;
  dependentCount: number;
  topDependents: DetailedDependentHit[];
}

export interface ImpactPackageRollup {
  name: string;
  dependentCount: number;
  symbols: string[];
  topDependents: DetailedDependentHit[];
}

export interface ImpactRollup {
  targetSymbols: string[];
  productionDependents: DetailedDependentHit[];
  packages: ImpactPackageRollup[];
  exports: ImpactExportRollup[];
  tests: TestFileHit[];
  topDependents: DetailedDependentHit[];
  topTests: TestFileHit[];
}

export interface BuildImpactRollupOptions {
  targetSymbols: string[];
  dependents: DetailedDependentHit[];
  tests?: TestHit[];
  projectRoot: string;
  top?: number;
}

export function relativeToProject(
  projectRoot: string,
  filePath: string,
): string {
  return filePath.startsWith(`${projectRoot}/`)
    ? filePath.slice(projectRoot.length + 1)
    : filePath;
}

export function impactPackageBucket(
  projectRoot: string,
  filePath: string,
): string {
  const rel = relativeToProject(projectRoot, filePath).replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0]) return parts[0];
  return path.basename(filePath) || ".";
}

function sortDetailedDependents(
  dependents: DetailedDependentHit[],
): DetailedDependentHit[] {
  return [...dependents].sort(
    (a, b) => b.sharedSymbols - a.sharedSymbols || a.file.localeCompare(b.file),
  );
}

export function buildImpactRollup(
  opts: BuildImpactRollupOptions,
): ImpactRollup {
  const top = Math.max(1, opts.top ?? 10);
  const productionDependents = sortDetailedDependents(
    opts.dependents.filter((d) => !isTestPath(d.file)),
  );
  const tests = groupTestHitsByFile(opts.tests ?? []);

  const exports = opts.targetSymbols
    .map((symbol) => {
      const matches = productionDependents.filter((d) =>
        d.symbols.includes(symbol),
      );
      return {
        symbol,
        dependentCount: matches.length,
        topDependents: matches.slice(0, top),
      };
    })
    .sort(
      (a, b) =>
        b.dependentCount - a.dependentCount || a.symbol.localeCompare(b.symbol),
    );

  const byPackage = new Map<
    string,
    { dependents: DetailedDependentHit[]; symbols: Set<string> }
  >();
  for (const dep of productionDependents) {
    const bucket = impactPackageBucket(opts.projectRoot, dep.file);
    const entry = byPackage.get(bucket) ?? {
      dependents: [],
      symbols: new Set<string>(),
    };
    entry.dependents.push(dep);
    for (const sym of dep.symbols) entry.symbols.add(sym);
    byPackage.set(bucket, entry);
  }

  const packages = [...byPackage.entries()]
    .map(([name, entry]) => ({
      name,
      dependentCount: entry.dependents.length,
      symbols: [...entry.symbols].sort(),
      topDependents: sortDetailedDependents(entry.dependents).slice(0, top),
    }))
    .sort(
      (a, b) =>
        b.dependentCount - a.dependentCount || a.name.localeCompare(b.name),
    );

  return {
    targetSymbols: [...opts.targetSymbols],
    productionDependents,
    packages,
    exports,
    tests,
    topDependents: productionDependents.slice(0, top),
    topTests: tests.slice(0, top),
  };
}

function symbolsLabel(symbols: string[]): string {
  if (symbols.length <= 3) return symbols.join(",");
  return `${symbols.slice(0, 3).join(",")}(+${symbols.length - 3})`;
}

export function formatImpactRollupHuman(
  rollup: ImpactRollup,
  opts: {
    target: string;
    projectRoot: string;
    includeTests: boolean;
  },
): string {
  const lines: string[] = [`Impact rollup for ${opts.target}:`, ""];
  lines.push("Summary:");
  lines.push(`  Exports: ${rollup.targetSymbols.length}`);
  lines.push(`  Production dependents: ${rollup.productionDependents.length}`);
  lines.push(`  Packages: ${rollup.packages.length}`);
  if (opts.includeTests) lines.push(`  Affected tests: ${rollup.tests.length}`);

  lines.push("", `Exports (${rollup.exports.length}):`);
  for (const ex of rollup.exports) {
    lines.push(
      `  ${ex.symbol}  ${ex.dependentCount} dependent${ex.dependentCount === 1 ? "" : "s"}`,
    );
    for (const dep of ex.topDependents) {
      lines.push(`    ${relativeToProject(opts.projectRoot, dep.file)}`);
    }
  }

  lines.push("", `Packages (${rollup.packages.length}):`);
  if (rollup.packages.length === 0) {
    lines.push("  none");
  } else {
    for (const pkg of rollup.packages) {
      lines.push(
        `  ${pkg.name}  ${pkg.dependentCount} file${pkg.dependentCount === 1 ? "" : "s"}  symbols:${symbolsLabel(pkg.symbols)}`,
      );
      for (const dep of pkg.topDependents) {
        lines.push(
          `    ${relativeToProject(opts.projectRoot, dep.file)} (${symbolsLabel(dep.symbols)})`,
        );
      }
    }
  }

  lines.push("", `Top dependents (${rollup.topDependents.length}):`);
  if (rollup.topDependents.length === 0) {
    lines.push("  none");
  } else {
    for (const dep of rollup.topDependents) {
      lines.push(
        `  ${relativeToProject(opts.projectRoot, dep.file)} (${symbolsLabel(dep.symbols)})`,
      );
    }
  }

  if (opts.includeTests) {
    lines.push("", `Affected tests (${rollup.tests.length}):`);
    if (rollup.topTests.length === 0) {
      lines.push("  none");
    } else {
      for (const test of rollup.topTests) {
        lines.push(
          `  ${relativeToProject(opts.projectRoot, test.file)}:${test.line + 1}  (${hopLabelHuman(test.hops)}${formatViaHuman(test.via)})`,
        );
      }
    }
  }

  return lines.join("\n");
}

export function formatImpactRollupAgent(
  rollup: ImpactRollup,
  opts: {
    target: string;
    projectRoot: string;
    includeTests: boolean;
  },
): string {
  const lines = [
    [
      "summary",
      `target=${opts.target}`,
      `exports=${rollup.targetSymbols.length}`,
      `deps=${rollup.productionDependents.length}`,
      `packages=${rollup.packages.length}`,
      `tests=${opts.includeTests ? rollup.tests.length : "skipped"}`,
    ].join("\t"),
  ];

  for (const ex of rollup.exports) {
    lines.push(["export", ex.symbol, `deps=${ex.dependentCount}`].join("\t"));
  }
  for (const pkg of rollup.packages) {
    lines.push(
      [
        "pkg",
        pkg.name,
        `deps=${pkg.dependentCount}`,
        `symbols=${symbolsLabel(pkg.symbols)}`,
      ].join("\t"),
    );
  }
  for (const dep of rollup.topDependents) {
    lines.push(
      [
        "dep",
        relativeToProject(opts.projectRoot, dep.file),
        `symbols=${symbolsLabel(dep.symbols)}`,
      ].join("\t"),
    );
  }
  if (opts.includeTests) {
    for (const test of rollup.topTests) {
      lines.push(
        [
          "test",
          `${relativeToProject(opts.projectRoot, test.file)}:${test.line + 1}`,
          hopLabelAgent(test.hops),
          formatViaAgent(test.via).trim(),
        ]
          .filter(Boolean)
          .join("\t"),
      );
    }
  }

  return lines.join("\n");
}

#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

interface BenchmarkRow {
  query: string;
  baselineTime: number;
  baselineCost: number;
  osgrepTime: number;
  osgrepCost: number;
  winner: 'baseline' | 'osgrep' | 'tie';
}

interface CumulativeData {
  totalBaselineTime: number;
  totalOsgrepTime: number;
  totalBaselineCost: number;
  totalOsgrepCost: number;
  queryCount: number;
  osgrepWins: number;
  baselineWins: number;
  ties: number;
}

function parseCSV(csvPath: string): BenchmarkRow[] {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  const rows: BenchmarkRow[] = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 6) continue;

    rows.push({
      query: parts[0],
      baselineTime: parseFloat(parts[1]) || 0,
      baselineCost: parseFloat(parts[2]) || 0,
      osgrepTime: parseFloat(parts[3]) || 0,
      osgrepCost: parseFloat(parts[4]) || 0,
      winner: (parts[5]?.toLowerCase() || 'tie') as 'baseline' | 'osgrep' | 'tie',
    });
  }

  return rows;
}

function calculateCumulative(rows: BenchmarkRow[]): CumulativeData {
  return rows.reduce(
    (acc, row) => ({
      totalBaselineTime: acc.totalBaselineTime + row.baselineTime,
      totalOsgrepTime: acc.totalOsgrepTime + row.osgrepTime,
      totalBaselineCost: acc.totalBaselineCost + row.baselineCost,
      totalOsgrepCost: acc.totalOsgrepCost + row.osgrepCost,
      queryCount: acc.queryCount + 1,
      osgrepWins: acc.osgrepWins + (row.winner === 'osgrep' ? 1 : 0),
      baselineWins: acc.baselineWins + (row.winner === 'baseline' ? 1 : 0),
      ties: acc.ties + (row.winner === 'tie' ? 1 : 0),
    }),
    {
      totalBaselineTime: 0,
      totalOsgrepTime: 0,
      totalBaselineCost: 0,
      totalOsgrepCost: 0,
      queryCount: 0,
      osgrepWins: 0,
      baselineWins: 0,
      ties: 0,
    }
  );
}

function generateHTML(cumulative: CumulativeData): string {
  const avgBaselineTime = cumulative.totalBaselineTime / cumulative.queryCount;
  const avgOsgrepTime = cumulative.totalOsgrepTime / cumulative.queryCount;
  const avgBaselineCost = cumulative.totalBaselineCost / cumulative.queryCount;
  const avgOsgrepCost = cumulative.totalOsgrepCost / cumulative.queryCount;
  
  const timeImprovement = ((avgBaselineTime - avgOsgrepTime) / avgBaselineTime * 100).toFixed(1);
  const costImprovement = ((avgBaselineCost - avgOsgrepCost) / avgBaselineCost * 100).toFixed(1);
  const osgrepWinRate = ((cumulative.osgrepWins / cumulative.queryCount) * 100).toFixed(0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>osgrep Benchmark Results</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'IBM Plex Mono', 'SF Mono', 'Consolas', monospace;
      background: linear-gradient(135deg, #f5f7f5 0%, #e8ebe8 100%);
      min-height: 100vh;
      padding: 48px 24px;
      color: #1a3d1a;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 64px;
    }

    .header h1 {
      font-size: 52px;
      font-weight: 700;
      color: #1a3d1a;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }

    .header p {
      font-size: 16px;
      color: #4a6b4a;
      font-weight: 400;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 48px;
    }

    .stat-card {
      background: white;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 4px 16px rgba(45, 90, 45, 0.08);
      border: 1px solid #e8f0e8;
      position: relative;
      overflow: hidden;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }

    .stat-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(45, 90, 45, 0.12);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, #2d5a2d 0%, #1a6f1a 100%);
    }

    .stat-label {
      font-size: 12px;
      color: #6b8a6b;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 16px;
      font-weight: 600;
    }

    .stat-values {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    .stat-row-label {
      font-size: 13px;
      color: #4a6b4a;
      font-weight: 500;
    }

    .stat-number {
      font-size: 24px;
      font-weight: 700;
    }

    .baseline {
      color: #7a9a7a;
    }

    .experimental {
      color: #2d5a2d;
    }

    .improvement-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, #1a6f1a 0%, #2d8a2d 100%);
      color: white;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 16px;
      font-weight: 700;
      margin-top: 16px;
    }

    .improvement-badge::before {
      content: '↓';
      font-size: 20px;
    }

    .neutral-badge {
      background: linear-gradient(135deg, #6b8a6b 0%, #7a9a7a 100%);
    }

    .neutral-badge::before {
      content: '→';
    }

    .chart-container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      box-shadow: 0 4px 16px rgba(45, 90, 45, 0.08);
      border: 1px solid #e8f0e8;
      margin-bottom: 32px;
    }

    .chart-title {
      font-size: 24px;
      font-weight: 700;
      color: #1a3d1a;
      margin-bottom: 32px;
      text-align: center;
      letter-spacing: -0.01em;
    }

    .bars {
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    .bar-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bar-label {
      font-size: 14px;
      font-weight: 600;
      color: #2d5a2d;
      margin-bottom: 4px;
    }

    .bar-wrapper {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .bar-track {
      flex: 1;
      height: 48px;
      background: #f5f7f5;
      border-radius: 8px;
      position: relative;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 16px;
      font-size: 14px;
      font-weight: 600;
      color: white;
      transition: width 1.5s cubic-bezier(0.4, 0, 0.2, 1);
      animation: slideIn 1.5s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideIn {
      from {
        width: 0 !important;
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    .bar-baseline {
      background: linear-gradient(90deg, #9db39d 0%, #8aa88a 100%);
    }

    .bar-experimental {
      background: linear-gradient(90deg, #2d5a2d 0%, #1a6f1a 100%);
    }

    .bar-value-label {
      min-width: 100px;
      text-align: right;
      font-size: 14px;
      font-weight: 600;
      color: #4a6b4a;
    }

    .chart-subtitle {
      font-size: 14px;
      font-weight: 600;
      color: #4a6b4a;
      margin-bottom: 32px;
      text-align: center;
    }

    .preference-bar {
      display: flex;
      height: 60px;
      border-radius: 8px;
      overflow: hidden;
      margin-top: 16px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    .preference-segment {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 700;
      color: white;
      transition: all 0.3s ease;
      position: relative;
    }

    .preference-segment:hover {
      filter: brightness(1.1);
    }

    .preference-osgrep {
      background: linear-gradient(90deg, #2d5a2d 0%, #1a6f1a 100%);
    }

    .preference-baseline {
      background: linear-gradient(90deg, #8aa88a 0%, #9db39d 100%);
    }

    .preference-tie {
      background: linear-gradient(90deg, #6b8a6b 0%, #7a9a7a 100%);
    }

    .preference-legend {
      display: flex;
      justify-content: center;
      gap: 24px;
      margin-top: 16px;
      font-size: 13px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .legend-color {
      width: 20px;
      height: 20px;
      border-radius: 4px;
    }

    .footer {
      text-align: center;
      margin-top: 64px;
      padding-top: 32px;
      border-top: 2px solid #e8f0e8;
      color: #6b8a6b;
      font-size: 13px;
    }

    .footer a {
      color: #2d5a2d;
      text-decoration: none;
      font-weight: 600;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      .header h1 {
        font-size: 36px;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .chart-container {
        padding: 24px;
      }

      .bar-wrapper {
        flex-direction: column;
        align-items: stretch;
      }

      .bar-value-label {
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>osgrep benchmark</h1>
      <p>Cumulative performance across ${cumulative.queryCount} queries</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Time</div>
        <div class="stat-values">
          <div class="stat-row">
            <span class="stat-row-label">Baseline</span>
            <span class="stat-number baseline">${Math.floor(cumulative.totalBaselineTime / 60)}m ${(cumulative.totalBaselineTime % 60).toFixed(0)}s</span>
          </div>
          <div class="stat-row">
            <span class="stat-row-label">osgrep</span>
            <span class="stat-number experimental">${Math.floor(cumulative.totalOsgrepTime / 60)}m ${(cumulative.totalOsgrepTime % 60).toFixed(0)}s</span>
          </div>
        </div>
        <div class="improvement-badge">${timeImprovement}% faster</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Cost</div>
        <div class="stat-values">
          <div class="stat-row">
            <span class="stat-row-label">Baseline</span>
            <span class="stat-number baseline">$${cumulative.totalBaselineCost.toFixed(2)}</span>
          </div>
          <div class="stat-row">
            <span class="stat-row-label">osgrep</span>
            <span class="stat-number experimental">$${cumulative.totalOsgrepCost.toFixed(2)}</span>
          </div>
        </div>
        <div class="improvement-badge ${parseFloat(costImprovement) < 0 ? 'neutral-badge' : ''}">${parseFloat(costImprovement) >= 0 ? costImprovement + '% cheaper' : Math.abs(parseFloat(costImprovement)).toFixed(1) + '% more'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">LLM Judge Preference</div>
        <div class="stat-values">
          <div class="stat-row">
            <span class="stat-row-label">osgrep wins</span>
            <span class="stat-number experimental">${cumulative.osgrepWins}</span>
          </div>
          <div class="stat-row">
            <span class="stat-row-label">Baseline wins</span>
            <span class="stat-number baseline">${cumulative.baselineWins}</span>
          </div>
          <div class="stat-row">
            <span class="stat-row-label">Ties</span>
            <span class="stat-number" style="color: #6b8a6b">${cumulative.ties}</span>
          </div>
        </div>
        <div class="improvement-badge">${osgrepWinRate}% win rate</div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-title">Performance Comparison in Claude Code</div>
      <div class="chart-subtitle">Average per-query metrics across ${cumulative.queryCount} queries in the OpenCode codebase</div>
      <div class="bars">
        <div class="bar-group">
          <div class="bar-label">Average Time per Query — ${timeImprovement}% faster</div>
          <div class="bar-wrapper">
            <div class="bar-track">
              <div class="bar-fill bar-baseline" style="width: 100%">
                Baseline
              </div>
            </div>
            <div class="bar-value-label">${Math.floor(avgBaselineTime / 60)}m ${(avgBaselineTime % 60).toFixed(0)}s</div>
          </div>
          <div class="bar-wrapper">
            <div class="bar-track">
              <div class="bar-fill bar-experimental" style="width: ${(avgOsgrepTime / avgBaselineTime * 100).toFixed(1)}%">
                osgrep
              </div>
            </div>
            <div class="bar-value-label">${Math.floor(avgOsgrepTime / 60)}m ${(avgOsgrepTime % 60).toFixed(0)}s</div>
          </div>
        </div>

        <div class="bar-group">
          <div class="bar-label">Average Cost per Query — ${parseFloat(costImprovement) >= 0 ? costImprovement + '% cheaper' : Math.abs(parseFloat(costImprovement)).toFixed(1) + '% more expensive'}</div>
          <div class="bar-wrapper">
            <div class="bar-track">
              <div class="bar-fill bar-baseline" style="width: 100%">
                Baseline
              </div>
            </div>
            <div class="bar-value-label">$${avgBaselineCost.toFixed(3)}</div>
          </div>
          <div class="bar-wrapper">
            <div class="bar-track">
              <div class="bar-fill bar-experimental" style="width: ${(avgOsgrepCost / avgBaselineCost * 100).toFixed(1)}%">
                osgrep
              </div>
            </div>
            <div class="bar-value-label">$${avgOsgrepCost.toFixed(3)}</div>
          </div>
        </div>

        <div class="bar-group">
          <div class="bar-label">LLM-as-Judge Quality Preference — ${osgrepWinRate}% osgrep wins</div>
          <div class="preference-bar">
            <div class="preference-segment preference-osgrep" style="width: ${(cumulative.osgrepWins / cumulative.queryCount * 100).toFixed(1)}%">
              ${cumulative.osgrepWins} osgrep
            </div>
            ${cumulative.ties > 0 ? `<div class="preference-segment preference-tie" style="width: ${(cumulative.ties / cumulative.queryCount * 100).toFixed(1)}%">
              ${cumulative.ties} tie${cumulative.ties !== 1 ? 's' : ''}
            </div>` : ''}
            <div class="preference-segment preference-baseline" style="width: ${(cumulative.baselineWins / cumulative.queryCount * 100).toFixed(1)}%">
              ${cumulative.baselineWins} baseline
            </div>
          </div>
          <div class="preference-legend">
            <div class="legend-item">
              <div class="legend-color" style="background: linear-gradient(90deg, #2d5a2d 0%, #1a6f1a 100%);"></div>
              <span>osgrep preferred</span>
            </div>
            ${cumulative.ties > 0 ? `<div class="legend-item">
              <div class="legend-color" style="background: linear-gradient(90deg, #6b8a6b 0%, #7a9a7a 100%);"></div>
              <span>Tie</span>
            </div>` : ''}
            <div class="legend-item">
              <div class="legend-color" style="background: linear-gradient(90deg, #8aa88a 0%, #9db39d 100%);"></div>
              <span>Baseline preferred</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>Generated with <a href="https://github.com/yourusername/osgrep" target="_blank">osgrep</a> benchmark tool</p>
    </div>
  </div>
</body>
</html>`;
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: ts-node generate-benchmark.ts <path-to-csv>');
    console.error('');
    console.error('CSV format:');
    console.error('Query,Baseline Time (s),Baseline Cost ($),osgrep Time (s),osgrep Cost ($),Winner');
    process.exit(1);
  }

  const csvPath = args[0];

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: File not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading benchmark data from: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`Parsed ${rows.length} benchmark queries`);

  const cumulative = calculateCumulative(rows);
  console.log('Calculating cumulative metrics...');

  const html = generateHTML(cumulative);
  
  const outputPath = path.join(path.dirname(csvPath), 'benchmark-results.html');
  fs.writeFileSync(outputPath, html, 'utf-8');

  console.log(`✓ Benchmark visualization generated: ${outputPath}`);
  console.log('');
  console.log('Summary:');
  console.log(`  Queries: ${cumulative.queryCount}`);
  console.log(`  Avg time improvement: ${((avgBaselineTime - avgOsgrepTime) / avgBaselineTime * 100).toFixed(1)}%`);
  console.log(`  Avg cost change: ${((avgBaselineCost - avgOsgrepCost) / avgBaselineCost * 100).toFixed(1)}%`);
  console.log(`  osgrep wins: ${cumulative.osgrepWins}/${cumulative.queryCount} (${((cumulative.osgrepWins / cumulative.queryCount) * 100).toFixed(0)}%)`);
}

main();
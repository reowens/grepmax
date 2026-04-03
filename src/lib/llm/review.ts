import * as path from "node:path";
import OpenAI from "openai";
import { GraphBuilder } from "../graph/graph-builder";
import { Searcher } from "../search/searcher";
import { VectorDB } from "../store/vector-db";
import { ensureProjectPaths } from "../utils/project-root";
import { getLlmConfig } from "./config";
import {
  extractDiff,
  readCommitInfo,
  extractChangedFiles,
  extractSymbols,
  detectLanguages,
  type CommitInfo,
} from "./diff";
import { appendReview, type Finding, type ReviewEntry } from "./report";
import { type InvestigateContext, executeTool } from "./tools";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  commitRef: string;
  projectRoot: string;
  verbose?: boolean;
}

export interface ReviewResult {
  commit: string;
  findingCount: number;
  duration: number;
  clean: boolean;
}

export async function reviewCommit(
  opts: ReviewOptions,
): Promise<ReviewResult> {
  const { commitRef, projectRoot, verbose = false } = opts;
  const wallStart = Date.now();

  // 1. Extract diff
  const diff = extractDiff(commitRef, projectRoot);
  if (!diff) {
    if (verbose) process.stderr.write("[review] empty diff, skipping\n");
    return { commit: commitRef, findingCount: 0, duration: 0, clean: true };
  }

  // 2. Commit metadata
  const info = readCommitInfo(commitRef, projectRoot);
  if (verbose) process.stderr.write(`[review] ${info.short} — ${info.message}\n`);

  // 3. Changed files & symbols
  const changedFiles = extractChangedFiles(commitRef, projectRoot);
  const symbols = extractSymbols(diff);
  const languages = detectLanguages(changedFiles);

  if (verbose) {
    process.stderr.write(`[review] files: ${changedFiles.length}, symbols: ${symbols.length}, langs: ${languages.join(", ")}\n`);
  }

  // 4. Gather context via gmax internal APIs
  let contextStr = "";
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  try {
    const searcher = new Searcher(vectorDb);
    const graphBuilder = new GraphBuilder(vectorDb, projectRoot);
    const ctx: InvestigateContext = { vectorDb, searcher, graphBuilder, projectRoot };

    contextStr = await gatherContext(symbols, changedFiles, ctx, verbose);
  } catch (err) {
    if (verbose) {
      process.stderr.write(`[review] context gathering failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } finally {
    await vectorDb.close();
  }

  // 5. Build prompts
  const systemPrompt = buildSystemPrompt(languages);
  const userPrompt = buildUserPrompt(info, diff, symbols, contextStr);

  // 6. Call LLM (single shot)
  const config = getLlmConfig();
  const modelName = path.basename(config.model, path.extname(config.model));
  const client = new OpenAI({
    baseURL: `http://${config.host}:${config.port}/v1`,
    apiKey: "local",
  });

  let content: string;
  try {
    if (verbose) process.stderr.write("[review] calling LLM...\n");
    const response = await client.chat.completions.create({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: config.maxTokens,
      temperature: 0,
    });

    content = response.choices?.[0]?.message?.content ?? "";
    if (!content) {
      if (verbose) process.stderr.write("[review] empty LLM response\n");
      content = "";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (verbose) process.stderr.write(`[review] LLM call failed: ${msg}\n`);
    const duration = Math.round((Date.now() - wallStart) / 1000);
    return { commit: info.short, findingCount: 0, duration, clean: true };
  }

  // 7. Parse response
  const { findings, summary } = parseFindings(content);
  const duration = Math.round((Date.now() - wallStart) / 1000);

  if (verbose) {
    process.stderr.write(`[review] ${findings.length} finding(s) in ${duration}s\n`);
  }

  // 8. Append to report
  const entry: ReviewEntry = {
    commit: info.short,
    message: info.message,
    timestamp: new Date().toISOString(),
    duration_seconds: duration,
    findings,
    summary,
    clean: findings.length === 0,
  };
  appendReview(projectRoot, entry);

  return {
    commit: info.short,
    findingCount: findings.length,
    duration,
    clean: findings.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

const CONTEXT_CHAR_BUDGET = 12_000;
const CONTEXT_TIMEOUT_MS = 15_000;

async function gatherContext(
  symbols: string[],
  changedFiles: string[],
  ctx: InvestigateContext,
  verbose: boolean,
): Promise<string> {
  // Launch all tool calls in parallel
  const peekPromises = symbols.map((s) =>
    executeTool("peek", { symbol: s }, ctx),
  );
  const impactPromises = symbols.map((s) =>
    executeTool("impact", { target: s, depth: 2 }, ctx),
  );
  const relatedPromises = changedFiles.map((f) =>
    executeTool("related", { file: f }, ctx),
  );

  const allPromises = [
    ...peekPromises.map((p) => p.then((r) => ({ type: "peek", result: r }))),
    ...impactPromises.map((p) => p.then((r) => ({ type: "impact", result: r }))),
    ...relatedPromises.map((p) => p.then((r) => ({ type: "related", result: r }))),
  ];

  // Race against timeout
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), CONTEXT_TIMEOUT_MS),
  );

  const settled = await Promise.race([
    Promise.allSettled(allPromises),
    timeout.then(() => "timeout" as const),
  ]);

  const peekResults: string[] = [];
  const impactResults: string[] = [];
  const relatedResults: string[] = [];

  if (settled !== "timeout") {
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { type, result } = s.value;
      if (result.startsWith("(") && (result.includes("not found") || result.includes("error") || result.includes("not indexed") || result.includes("none"))) continue;
      if (type === "peek") peekResults.push(result);
      else if (type === "impact") impactResults.push(result);
      else relatedResults.push(result);
    }
  } else if (verbose) {
    process.stderr.write("[review] context gathering timed out\n");
  }

  // Assemble with char budget
  let chars = 0;
  const sections: string[] = [];

  if (peekResults.length > 0) {
    const section = `### Callers & Dependents\n${peekResults.join("\n")}\n`;
    sections.push(section);
    chars += section.length;
  }

  if (impactResults.length > 0 && chars < CONTEXT_CHAR_BUDGET) {
    const section = `### Impact Analysis\n${impactResults.join("\n")}\n`;
    sections.push(section);
    chars += section.length;
  }

  if (relatedResults.length > 0 && chars < CONTEXT_CHAR_BUDGET) {
    const section = `### Related Files\n${relatedResults.join("\n")}\n`;
    sections.push(section);
  }

  if (verbose) {
    process.stderr.write(`[review] context: ${peekResults.length} peek, ${impactResults.length} impact, ${relatedResults.length} related\n`);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt construction (ported from sentinel/src/lib/prompt.sh)
// ---------------------------------------------------------------------------

function buildSystemPrompt(languages: string[]): string {
  let prompt = `You are Sentinel, a senior code reviewer analyzing git commits. You review diffs alongside codebase context (call graphs, dependents, related files) provided by a semantic search tool.

Your job is to find issues that could cause bugs, crashes, security vulnerabilities, or breaking changes at runtime. You are not a linter — ignore style, formatting, naming conventions, and minor nitpicks.

Focus on:
- Changes that break callers or dependents (evidence provided)
- Logic errors, off-by-one, incorrect conditions
- Missing error handling that could crash at runtime
- Security issues: injection, auth bypass, secrets, unsafe input
- State mutations with unprotected concurrent access
- Resource leaks: unclosed connections, missing cleanup
- API contract violations: return type changes, removed fields, changed semantics

Do not flag:
- Style or formatting
- Missing comments or documentation
- Test coverage
- Performance unless it's a clear regression (N+1, unbounded loop)
- Things the compiler/type system already catches`;

  if (languages.includes("typescript")) {
    prompt += `

## TypeScript Checks
- Missing \`await\` on async calls
- \`any\` type hiding real type errors
- Non-exhaustive switch on discriminated unions
- Promise fire-and-forget without error handling
- Optional chaining masking bugs where value should never be null`;
  }

  if (languages.includes("swift")) {
    prompt += `

## Swift Checks
- Force unwraps (\`!\`) outside test files
- Missing \`[weak self]\` in escaping closures
- Missing \`@MainActor\` on UI state mutations
- \`try!\` or \`try?\` silently swallowing errors
- Sendable violations in concurrent code`;
  }

  if (languages.includes("kotlin")) {
    prompt += `

## Kotlin Checks
- Coroutine scope leaks (GlobalScope, unstructured)
- Missing null checks on Java interop boundaries
- Fragment lifecycle violations
- Hardcoded strings that should be resources`;
  }

  prompt += `

## Thinking

Before issuing your verdict, reason through:
1. What changed in this diff?
2. What is the blast radius? (use the provided caller/dependent evidence)
3. Could this break something at runtime that the compiler won't catch?
4. Is there a security implication?

## Output Format

Respond with ONLY valid JSON. No markdown, no explanation outside the JSON.

If no issues found:
{"findings": [], "summary": "Clean commit — no runtime risks identified."}

If issues found:
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "error|warning",
      "category": "breaking_change|logic_error|security|resource_leak|concurrency|missing_error_handling",
      "symbol": "functionName",
      "message": "Brief description of the issue",
      "evidence": ["CallerA.swift:34 still expects Optional<User>"],
      "suggestion": "One-line fix suggestion"
    }
  ],
  "summary": "Brief summary of all findings."
}

Severity guide:
- error: will break at runtime, security vulnerability, data loss
- warning: could break under certain conditions, smells risky

Be concise. One sentence per message. Evidence from the codebase context, not speculation.`;

  return prompt;
}

function buildUserPrompt(
  info: CommitInfo,
  diff: string,
  symbols: string[],
  context: string,
): string {
  let prompt = `## Commit
${info.short} — ${info.message}

## Diff
${diff}

## Codebase Context
`;

  if (symbols.length > 0) {
    prompt += `### Changed Symbols\n${symbols.join("\n")}\n\n`;
  }

  if (context) {
    prompt += context;
  }

  prompt += `\nReview this commit. Think through the blast radius using the provided context, then output your findings as JSON.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function stripThinkTags(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, "")
    .trim();
}

function parseFindings(content: string): { findings: Finding[]; summary: string } {
  const empty = { findings: [], summary: "Parse error — could not extract findings from model output." };
  if (!content) return empty;

  // Strip think tags and markdown fences
  let cleaned = stripThinkTags(content);
  cleaned = cleaned.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "");

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.findings)) {
      return {
        findings: validateFindings(parsed.findings),
        summary: String(parsed.summary || "No summary."),
      };
    }
  } catch {}

  // Fallback: extract JSON between first { and last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const extracted = cleaned.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(extracted);
      if (Array.isArray(parsed.findings)) {
        return {
          findings: validateFindings(parsed.findings),
          summary: String(parsed.summary || "No summary."),
        };
      }
    } catch {}
  }

  return empty;
}

function validateFindings(raw: unknown[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (!f.file || !f.message) continue;
    findings.push({
      file: String(f.file),
      line: Number(f.line) || 0,
      severity: f.severity === "error" ? "error" : "warning",
      category: String(f.category || "logic_error") as Finding["category"],
      symbol: String(f.symbol || ""),
      message: String(f.message),
      evidence: Array.isArray(f.evidence) ? f.evidence.map(String) : [],
      suggestion: String(f.suggestion || ""),
    });
  }
  return findings;
}

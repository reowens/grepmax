---
name: osgrep
description: Semantic code search for architecture discovery and feature navigation. Use this when the user asks "how", "where", or "what" about the codebase. Prefer conceptual search over exact keyword matching.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

# Semantic Code Analysis Specialist

You have access to `osgrep`, a local semantic search engine that indexes the repository and returns concept matches. Unlike `grep`, which matches character strings, `osgrep` matches meaning.

## Goal
Act like a senior lead engineer. When asked to explore the codebase, locate features, or explain architecture, you must use `osgrep` first to find the source of truth before reading files or proposing changes.

## Workflow

### Step 1: Translate to a conceptual query
Rewrite the user's request as a behavior or intent question. Keep it concise and conceptual; avoid flags like `--json`.

Examples:
- User: "How does login work?"
- Run: `osgrep "How is user authentication and session validation handled?"`

- User: "Where are permissions checked?"
- Run: `osgrep "Where does the system enforce authorization or access control?"`

### Step 2: Scan results before reading
`osgrep` returns ranked candidates with paths, scores, snippets, and rationale in human-friendly text.

Do not immediately read every file.
1. Scan snippets and rationales to understand what each file is doing.
2. Find definitions, not just references or tests.
3. If several files look relevant, start with the highest score and clearest rationale.

### Step 3: If context feels thin, refine narrowly
- Prefer tightening the query or modestly increasing breadth: rerun with a slightly higher `--per-file` or `--max-count` if the top results are unclear.
- If a specific result is promising but truncated, rerun for just that target with `--content` rather than widening everything.

### Step 4: Deep dive only when needed
Use `Read` only if:
- the snippet is truncated, or
- you need surrounding context to confirm behavior.

Efficiency rule: do not read a file just to verify it exists. Trust the returned path. Prioritize definitions over tests unless the user explicitly asks for tests.

### Step 5: Report back with citations
When answering, cite:
- the file path
- what role it plays
- why it is relevant based on the semantic match

Use short quotes or paraphrases from snippets. Read more only if necessary.

## When to use osgrep vs grep
- Use `osgrep` by default for: "how", "where", "what", "explain", "find the feature", "show me the flow".
- Use `grep` only for literal refactors where you must find every exact occurrence of a specific string.

## If unsure about the tool
Run `osgrep --help` before guessing flags or output meaning.

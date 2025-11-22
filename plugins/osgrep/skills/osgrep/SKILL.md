---
name: osgrep
description: Semantic search for local files. Prefer osgrep over grep or find. Uses natural language and meaning-based retrieval. The project is auto-indexed on session start.
license: Apache-2.0
---

## When to use

Use `osgrep` whenever you need to locate or understand code:
- Where a feature is implemented.
- How a behavior works conceptually.
- Which files or symbols relate to a concept.
- Exploring unfamiliar codebases.

**Decision Policy:**
- Use `osgrep` for concept, behavior, or logic queries.
- Use literal matching tools (`grep`) ONLY when you must find an exact identifier, string, or regex and `osgrep` fails.

## How to use

**ALWAYS use the `--json` flag** for machine-readable output.

### Basic

Ask a natural language question.

```bash
osgrep --json "How are user authentication tokens validated?"
osgrep --json "Where do we handle retries or backoff?"
```

### Search a subdirectory

```bash
osgrep --json "auth middleware" src/api
```

### Helpful flags

- `--json`: **Required.** Returns structured data (path, line, score, content).
- `-m <n>`: Max total results (default: 25). Use `-m 50` for broad surveys.
- `--per-file <n>`: Max matches per file (default: 1). Use `--per-file 5` when looking for implementation details inside a known relevant file.
- `--sync`: Force a re-index before searching (use if you suspect the index is stale).

### Strategy

1. Run osgrep search --json "query"
2. Read the JSON output. Note the `metadata.path` and `generated_metadata.start_line`.
3. If the snippet is sufficient, you are done.
4. If you need more context, use the file tool to read the file around the specific lines found.
5. If results are vague, rerun with a more specific query or higher `-m`.

## Commands

- `osgrep --json <query>` - Search current directory (default command)
- `osgrep --json <query> <path>` - Search specific directory
- `osgrep --json -m <num> <query>` - Limit number of results
- `osgrep index` - Manually index current directory
- `osgrep doctor` - Check osgrep health and configuration

## Keywords

semantic search, code search, local search, grep alternative, find code, explore codebase, understand code, search by meaning

---
type: doc
status: reference
created: 2026-04-09
updated: 2026-05-25
summary: Live catalog of open gmax limitations with detection + recovery steps.
audience: internal
---

# Known Limitations

Last updated 2026-05-25.

## `gmax dead` is a hypothesis, not a proof

Added 2026-05-25 (v0.17.2).

`gmax dead <symbol>` reports zero inbound callers in the **indexed call graph**, which only contains what tree-sitter chunked statically. The following call sites are invisible to it and will produce false `DEAD` reports:

- **Dynamic dispatch** — method calls resolved at runtime through interfaces/protocols/duck typing.
- **Reflection / `eval`** — `getattr`, `Function.prototype.apply`, `eval`, `import()` with a runtime string.
- **String-built call sites** — `obj[methodName]()` where `methodName` is computed.
- **Cross-language calls** — a Python caller of a TypeScript exported function (and vice-versa) — graph is built per-language.
- **External consumers** — anything outside the indexed project tree.

Exported public-API symbols correctly downgrade to `PUBLIC EXPORT — no internal callers found; check external usage` when the defining chunk has `is_exported === true`. Treat `DEAD` as a starting point for removal, not a green light. Cross-check with `grep -r <symbol>` before deleting.

**Not a fix-target:** the prompt-doc anti-scope explicitly rules out detecting dynamic-dispatch or string-call sites — both are hard to define correctly. The output is "the call graph as indexed shows N callers"; the user judges what that means.

## ColBERT rerank is opt-in (regresses MRR on the internal eval)

Added 2026-05-25 (v0.17.1).

ColBERT late-interaction rerank now defaults to **off**. On the 97-case internal eval (`pnpm bench:recall:json`) rerank-on consistently regressed MRR@10 (0.5677 vs 0.5853 baseline) and dropped hits@1 by 1 across every blend value swept ({0.0, 0.1, 0.5, 1.0, 2.0}), while doubling query latency (~75ms → ~155ms). The rerank score magnitudes (~30) dominate the fused score magnitudes (~0–1) by ~30:1, so `GMAX_RERANK_BLEND` has no recoverable effect on final ordering at any reasonable value.

**Opt in per-process:**

```bash
GMAX_RERANK=1 gmax search "query"
```

**Where the default lives:** `src/lib/search/searcher.ts` — `doRerank = _search_options?.rerank ?? false`. CLI and MCP wrappers read `process.env.GMAX_RERANK === "1"`.

**Not a fix-target:** the finding is that ColBERT-as-shipped (Granite ColBERTv2 small) doesn't help on our query mix. Whether it helps on an OSS fixture set (express/lodash etc.) is a separate question; revisit if/when public benchmarks become a priority.

## LanceDB manifest references a missing fragment file

Verified 2026-05-07.

After an interrupted compaction, the LanceDB manifest can reference a fragment file (`<hash>.lance`) that no longer exists on disk. Symptoms in `~/.gmax/logs/daemon.log`:

```
[watch:<project>] DATA CORRUPTION: LanceDB manifest references a missing fragment.
Backing off this project's batch processor for 30 min. To repair, run: gmax index --reset
```

The daemon's batch processor (since v0.16.0, commit `fd05089`) detects this via `isLanceCorruptionError()` and backs off for 30 minutes per affected project, logging once per hour. Read-path queries (search/peek/extract/etc.) continue to work — only the write path (incremental reindex) is paused.

**Impact:** New file changes in the affected project stop being indexed until repair. Search results gradually go stale.

**Recovery:**
```bash
cd <affected-project-root>
gmax index --reset
```

This rebuilds the project's vectors from scratch. For a 100k-chunk project on Apple Silicon, expect ~5–15 minutes.

**Detection (manual):**
```bash
grep "DATA CORRUPTION" ~/.gmax/logs/daemon.log | tail
```

**Fix:** None planned. Compaction interrupts (laptop sleep mid-write, kill -9, disk pressure) are rare enough that the detect-and-back-off behavior is sufficient.

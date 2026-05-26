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

## ColBERT rerank is opt-in (shape-sensitive: helps monolithic files, hurts modular repos)

Added 2026-05-25 (v0.17.1). Refined 2026-05-25 with OSS-fixture evidence.

ColBERT late-interaction rerank defaults to **off**. Three fixture sets across two code shapes:

| Dataset | Code shape | rerank-off MRR | rerank-on MRR | Δ MRR | R@10 off→on | hits@1 off→on |
|---|---|---|---|---|---|---|
| gmax (97 cases) | modular TS | 0.5938 | 0.5657 | **−0.028** | 0.804 → 0.794 | 47 → 44 |
| express 4.21.1 (9 cases) | modular CommonJS | 0.6519 | 0.4778 | **−0.174** | 0.889 → 0.889 | 5 → 3 |
| platform (15 cases, private) | modular monorepo (pnpm) | 0.5467 | 0.3962 | **−0.151** | 0.733 → 0.733 | 6 → 4 |
| lodash 4.17.21 (10 cases) | monolithic IIFE | 0.3667 | 0.6500 | **+0.283** | 0.600 → 0.900 | 2 → 5 |

Fixtures are sverklo-bench P1 (definition lookup) ported verbatim from [sverklo/sverklo-bench](https://github.com/sverklo/sverklo-bench); platform fixtures hand-curated against a private monorepo using the same bare-symbol query methodology. Reproduce via `npx tsx src/eval-oss.ts <dataset>` (or `all`) with `GMAX_EVAL_RERANK=1` to toggle. Rerank doubles query latency in all cases (~75ms → ~155ms).

Note that for every modular dataset, **recall@10 is unchanged** between modes — rerank perturbs the top-10 ordering but never promotes a new file *into* the top-10. The hits@1 drop is the entire user-visible cost.

**The shape-sensitivity pattern.** On modular codebases each expected hit lives in its own file; fusion already picks the right file from filename/path signals, and ColBERT perturbs ranks within the correct candidate pool — usually for the worse. On monolithic single-file repos (lodash.js is 17K lines, hundreds of chunks) fusion can't discriminate within the file, and ColBERT's token-level scoring is the only mechanism that promotes the right chunk to the top.

**Opt in per-process:**

```bash
GMAX_RERANK=1 gmax search "query"
```

If you're indexing a single-file library, large generated/bundled code, or a datalake-style repo, the +30% recall is probably worth the latency. For modular projects, leave it off.

**Where the default lives:** `src/lib/search/searcher.ts` — `doRerank = _search_options?.rerank ?? false`. CLI and MCP wrappers read `process.env.GMAX_RERANK === "1"`.

**Not a fix-target right now.** A "candidate-concentration heuristic" — auto-enable rerank when the top-K candidates concentrate ≥80% in one file — would be the principled fix but requires more measurement work. Revisit if user reports of monolithic-file repos come in.

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

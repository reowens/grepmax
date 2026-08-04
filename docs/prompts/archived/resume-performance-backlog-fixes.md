---
type: prompt
status: archived
created: 2026-08-04T08:47:25Z
updated: 2026-08-04T09:06:57Z
dotmd_version: 0.70.4
context: "Resume Performance Backlog Fixes"
related_plans:
plan: docs/archived/performance-backlog-fixes.md
---

**Historical resume point:** implement Phase 1A of [`docs/archived/performance-backlog-fixes.md`](../../archived/performance-backlog-fixes.md) — `tree.delete()` in chunker.ts + skeletonizer.ts. This work is now complete; the archived plan contains the measured closeout. Findings catalog with evidence: [`docs/2026-08-04-performance-review.md`](../../2026-08-04-performance-review.md).

Rollout order is decided and recorded in the plan: **1A → 2 → 3 → 4 → 5A → 5B**. Phases 2–4 are independent if you want parallel branches.

**Gotchas that will cost you:**
- **1B (RSS threshold retune) must NOT ship with 1A** — current 1536MB was calibrated with the leak present; re-measure both embed modes first (rule: ~1.25× ONNX p95, never ≤1152).
- **Phase 2's silent trap:** post-switch, Arrow hands rerank a `Uint8Array` view that falls through every `coerceColbertBytes` branch → rerank silently no-ops. The spec's ArrayBuffer.isView branch is REQUIRED, and CI is blind to the whole change (pool + child_process are mocked) — the e2e steps are mandatory.
- **Worker changes need deploy + daemon restart to take effect:** `pnpm build && npm install -g .` then kill/restart daemon (global gmax = npm-installed grepmax, not this checkout).
- pnpm 10 migrated overrides to top-level in package.json (committed d8cc3b7); plain `pnpm install` works now, `--frozen-lockfile` was the thing that broke before.

**Already shipped this session (don't redo):** watcher any-depth ignore globs + `.turbo` (fd11906, deployed, daemon restarted, verified live with probes); CLAUDE.md now mandates opus subagents (5849bda). Suite green at 120 files / 1001 tests. Kernel panic of 2026-08-03 investigated and NOT gmax — see the review doc's panic section before re-litigating.

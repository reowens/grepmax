---
type: plan
status: planned
created: 2026-08-26T02:05:00Z
updated: 2026-08-26T02:05:00Z
surfaces:
  - store
  - release
modules:
  - src/lib/store/vector-db.ts
  - scripts/lancedb-fts-soak.mts
  - pnpm-workspace.yaml
domain: upgrade @lancedb/lancedb 0.31 (lance 8) to 0.38 (lance 11) to pick up the upstream FTS merge fix
audience: internal
parent_plan: docs/plans/lance-fts-merge-upstream.md
related_docs:
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
  - docs/known-limitations.md
current_state: Upstream fixed the FTS incremental-merge panic (lance-format/lance#8312, merged 2026-08-23) in lance v11.0.0-beta.22, which @lancedb/lancedb 0.38.0-beta.6+ pins (beta.10 as of 2026-08-25). No stable lancedb release carries it — 0.37.1 is on lance 10.0.0. lance 11.0.0 is at rc.2, so stable 0.38.0 is imminent. gmax is on 0.31.0 / lance 8.0.0 with the drop-and-rebuild panic guard in vector-db.ts.
next_step: Phase 0 — build the store-copy soak harness against 0.38.0-beta.10 while waiting for stable; do not touch the live store or the pinned dependency until Phase 2.
summary: Upgrade LanceDB three lance majors to remove the FTS merge panic at the source, with a rollback-safe cutover.
---

# LanceDB 0.31 → 0.38 Upgrade

## Problem

Every FTS incremental merge on 0.31 can panic (`builder.rs:856` out-of-bounds). The local guard
absorbs it by dropping and rebuilding the whole FTS index — correct, but each rebuild is a
multi-minute whole-index rewrite (1.5–2.1 min at 351k rows), and rebuild churn was one input to
the compaction volume implicated in the kernel-zone incident. Upstream has now fixed the merge
itself: [lance#8312](https://github.com/lance-format/lance/pull/8312) *normalize token cursor
before incremental merge*, independently reproduced by a third party with a 4-second Rust repro.

## What Is Known

| Fact | Source |
|---|---|
| Fix is in lance `v11.0.0-beta.22` and every later tag (`rc.1`, `rc.2`, `v12.0.0-beta.*`); **not** in `beta.21` | `gh api compare 2c1500f...<tag>` |
| lancedb `0.38.0-beta.6` … `beta.10` pin lance `=11.0.0-beta.22` (git tag) | lancedb `Cargo.toml` at each tag |
| lancedb `0.37.1` (latest stable) pins lance `=10.0.0` — no fix | same |
| gmax pins `@lancedb/lancedb 0.31.0` → lance `=8.0.0`; `apache-arrow ^18.1.0` is inside 0.38's peer range `>=15 <=18.1.0` | `package.json`, npm `peerDependencies` |
| lance v9 made **FTS index format v2 the default** | lance v9.0.0 release notes (`feat(fts)!`) |
| lance v11 rc "compose exact current-format readers", "centralize dataset version policies", "make index file versions exact" | lance v11.0.0-rc.2 notes |
| Node-side breaking changes 0.32→0.37.1 are all Arrow-metadata / nested-data / pagination fixes; none touch the 18 table/connection methods vector-db.ts uses | lancedb release notes; `grep` of vector-db.ts |
| Store: 12 GB on disk, 9.4 GB logical, 351k rows, 66 GB free — room for one APFS clone | `gmax doctor`, `df` |
| Prior 0.31 soak methodology exists and was retracted once after live exposure falsified it | incident doc 2026-08-05 entry; `scripts/lancedb-fts-soak.mts` |

## Risks

1. **FTS index format.** After the first FTS build under lance 11 the index is v2. lance 8
   cannot read it, so a rollback to 0.31 must drop the FTS index and rebuild (≈2 min), or restore
   the pre-cutover snapshot. Data fragments should remain readable both ways, but rc.2's
   "exact format" refactors make that an assumption to test, not assume.
2. **Two writers, two versions.** Global `gmax` and the daemon come from the same install, but a
   `gmax` CLI from another Node version / `npm link` could open the store with the old crate.
   The reader lease does not encode the crate version.
3. **Beta pin.** Shipping on `0.38.0-beta.N` means a git-tag lance dependency in a prebuilt
   binary — acceptable for the soak, not for the release. Wait for `0.38.0` stable unless the rc
   stalls past two weeks.
4. **Kernel-zone sensitivity.** The soak is bulk APFS churn — the class of activity that was
   quarantined on 25F84. Host is on 25G83 with 45 h of bounded zone evidence; still take a
   `zprint` before and after.
5. **Retracted-soak precedent.** The 2026-08-04 soak passed and the live store then disproved it.
   The acceptance below therefore includes a live canary period, not just the harness.

## Phases

### Phase 0 — Harness (now, no dependency change)

- Extend `scripts/lancedb-fts-soak.mts` to take `--module-root` pointing at a scratch install of
  `@lancedb/lancedb@0.38.0-beta.10` (it already parameterizes the module root).
- Snapshot the live store with an APFS clone (`cp -c -R ~/.gmax/lancedb <scratch>/lancedb-snap`)
  while the daemon is idle; verify the clone opens on **0.31** first.
- Run the soak on the clone with 0.38: the existing incremental-merge workload that reproduced the
  panic 26 times on 0.31. Target: zero panics across ≥ 12 qualifying cycles. Record `zprint`
  before/after.
- Cross-version read matrix on the clone: open a store written by 0.38 with 0.31 (expect: data
  readable, FTS index unreadable → confirm the guard's drop-and-rebuild path handles it); open a
  0.31 store with 0.38 (expect: readable, FTS adopted or rebuilt).
- Deliverable: a results section in this plan with the numbers.

### Phase 1 — Code (branch, gated on Phase 0)

- Bump `@lancedb/lancedb` in `package.json`; check `pnpm-workspace.yaml` overrides (the
  `mathjs`/audit pins) still resolve; `pnpm audit --prod` clean.
- Typecheck against the new `.d.ts`; fix any of the 18 call sites that moved.
- Keep the FTS panic guard in `vector-db.ts` but demote its log from expected-behaviour to a
  loud warning: after the upgrade a panic is a regression to report, not a known cost.
- Update `CLAUDE.md` (remove "do not attempt to fix it by bumping LanceDB"), `known-limitations.md`,
  and the archived FTS-panic docs' pointers.
- Full gate + a `gmax doctor` on the soak clone opened by the new build.

### Phase 2 — Cutover (release)

- Precondition: `0.38.0` stable on npm (or an explicit decision to ship the beta).
- Take a fresh APFS clone of the live store as the rollback point; note its path in this plan.
- Release via `npm version patch` as usual; the daemon restart is the cutover.
- First action after restart: one forced `optimize` and watch for the FTS merge path to run
  clean. Then 7 days of live canary: count `FTS rebuild` / panic lines in `daemon.log` (expect 0),
  compaction `freed` totals, and daily `zprint`.

### Phase 3 — Closeout

- Delete the rollback clone after the canary window.
- Close `docs/plans/lance-fts-merge-upstream.md` (its steps 2–3 become moot).
- If the guard fired even once during canary: reopen lance#8310 with the new backtrace.

## Rollback

`npm install -g grepmax@<last-0.31-release>` + daemon restart, then either restore the
clone, or let the guard drop the v2 FTS index and rebuild it under lance 8. Phase 0's read matrix
decides which of those is the default.

## Acceptance

- Phase 0 soak: 0 panics, ≥ 12 qualifying cycles, zone delta within baseline drift.
- Phase 2 canary: 0 FTS panic/rebuild lines over 7 days on the live store; search recall spot
  check unchanged (`pnpm bench:oss` byte-identical or explained).

## Non-Goals

- IVF/ANN index changes (`GMAX_ANN` stays off; the recall soak is a separate plan).
- Re-embedding or schema changes — this is a crate bump, not a store migration.
- Pulling any other lance 9–11 feature.

## Version History

- **2026-08-26T02:05:00Z** Scoped. Fix location pinned to lance v11.0.0-beta.22 / lancedb
  0.38.0-beta.6+; stable not yet published; FTS v2 format identified as the rollback constraint.

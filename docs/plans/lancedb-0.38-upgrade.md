---
type: plan
status: archived
created: 2026-08-26T02:05:00Z
updated: 2026-08-26T03:15:00Z
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
current_state: Phase 0 ran 2026-08-25 as a lance-11 *control*, not a fix validation. The fix (lance-format/lance#8312) is in lance v11.0.0-beta.22, which lancedb 0.38.0-beta.6+ pins — but beta.6 through beta.10 exist only as git tags in the lancedb repo. npm has published exactly two 0.38 prereleases, beta.0 and beta.3, and beta.3 is built against lance 11.0.0-beta.16, six tags before the fix. npm blocks the *release*, not the soak — beta.10 prebuilts are available as GitHub release assets and can be soaked against directly. What the control did establish, on an APFS clone of the live 352k-row store, is that lance 11 is bidirectionally format-compatible with lance 8 and that the 18 table/connection methods vector-db.ts uses are signature-identical. gmax is on 0.31.0 / lance 8.0.0 with the drop-and-rebuild panic guard in vector-db.ts.
next_step: none — shipped in v0.26.23 as beta.3 on npm + vendored beta.10 overlay (scripts/postinstall.js). Phases 1–3, canary and rollback clone dropped by decision 2026-08-25: single-user tool, rebuild on failure.
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
| lancedb `0.38.0-beta.6` … `beta.10` pin lance `=11.0.0-beta.22` (git tag), but **exist only as git tags** — none is published to npm | lancedb `Cargo.toml` at each tag; `npm view @lancedb/lancedb versions` |
| npm has exactly two `0.38` prereleases: `0.38.0-beta.0` and `0.38.0-beta.3` (`preview` dist-tag). `beta.3` builds against lance git rev `d514a61` = `11.0.0-beta.16` — **six tags before the fix**, so it is a lance-11 *control*, not a fix build | `npm view`; error backtrace paths from the installed `.node` |
| `beta.10` prebuilts are downloadable from the lancedb **GitHub release** assets (`darwin-arm64.zip` + `nodejs-dist.zip`); that `.node` links lance rev `ea3cb4d`, distinct from beta.3's. Good enough to soak against, not to ship | `~/.gmax/scratch/lancedb-beta10/` |
| lancedb `0.37.1` (latest stable, `latest` dist-tag) pins lance `=10.0.0` — no fix | same |
| gmax pins `@lancedb/lancedb 0.31.0` → lance `=8.0.0`; `apache-arrow ^18.1.0` is inside 0.38's peer range `>=15 <=18.1.0` | `package.json`, npm `peerDependencies` |
| lance v9 made **FTS index format v2 the default** | lance v9.0.0 release notes (`feat(fts)!`) |
| lance v11 rc "compose exact current-format readers", "centralize dataset version policies", "make index file versions exact" | lance v11.0.0-rc.2 notes |
| Node-side breaking changes 0.32→0.37.1 are all Arrow-metadata / nested-data / pagination fixes; none touch the 18 table/connection methods vector-db.ts uses | lancedb release notes; `grep` of vector-db.ts |
| Store: 12 GB on disk, 9.4 GB logical, 351k rows, 66 GB free — room for one APFS clone | `gmax doctor`, `df` |
| Prior 0.31 soak methodology exists and was retracted once after live exposure falsified it | incident doc 2026-08-05 entry; `scripts/lancedb-fts-soak.mts` |

## Risks

1. **FTS index format.** ~~After the first FTS build under lance 11 the index is v2. lance 8
   cannot read it, so a rollback to 0.31 must drop the FTS index and rebuild (≈2 min), or restore
   the pre-cutover snapshot.~~ **Not observed in Phase 0** — 0.31 read a lance-11-authored FTS
   index and answered both term and phrase queries with byte-identical result sets. See the read
   matrix in the results section. Retest on the fix-bearing build before relying on it.
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

### Phase 0 — Harness (ran 2026-08-25 as a control; fix validation still pending)

**Not the fix build.** The fix-bearing lancedb versions (`0.38.0-beta.6`+) are unpublished on npm;
the newest npm 0.38 is `0.38.0-beta.3`, on lance `11.0.0-beta.16` — before the fix. The soak below
therefore ran against beta.3 as a **lance-11 control**: it measures format compatibility and the
API surface, and it cannot say anything about whether lance#8312 works.

npm is the blocker for *shipping*, not for *soaking* — `beta.10` prebuilts exist as GitHub release
assets and can be unpacked into a module root that `--module-root` accepts. Rerunning the soak
that way is the cheapest path to a real fix validation, and does not commit the dependency.

- `scripts/lancedb-fts-soak.mts` already takes `--module-root`; no harness change was needed. It
  needs no embed server — it writes zero-filled 384-d vectors plus one seed vector read out of the
  store under test.
- Snapshot the live store with an APFS clone (`cp -c -R ~/.gmax/lancedb <scratch>/lancedb-snap`)
  while the daemon is idle; verify the clone opens on **0.31** first. ✅ done
- Run the soak on a second clone with 0.38: the incremental-merge workload. ✅ done — 12/12
  qualifying cycles, 0 panics. **This is not evidence of a fix.** The same harness recorded 0
  panics on 0.31 in the 2026-08-04 run, and live exposure then produced six. The harness is a
  compatibility and throughput probe, not a panic reproducer.
- Cross-version read matrix on the clone. ✅ done — all four legs read and query cleanly; the
  predicted FTS-format wall did not appear.
- **Still to do:** rerun the soak on a fresh clone against a fix-bearing build — either the
  `beta.10` GitHub release prebuilts now, or an npm-published ≥ `beta.6` / stable `0.38.0` later.
  That run is the one whose 0-panic result means something, and it only means something read
  alongside the Phase 2 live canary.
- Deliverable: a results section in this plan with the numbers. ✅ below

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

## Phase 0 results (2026-08-25, control run on beta.3)

### What this run can and cannot claim

It is a **lance-11 control**. `@lancedb/lancedb@0.38.0-beta.3` links lance git rev `d514a61`
(`11.0.0-beta.16`); the FTS merge fix landed in `11.0.0-beta.22`. The run therefore answers "does
lance 11 read, write, and interoperate with our lance-8 store" — not "is the panic fixed."

Read the 0-panic result against the precedent: the same harness scored 0 panics on 0.31 and 1 on
0.30 in the 2026-08-04 soak, and that comparison was retracted after live exposure produced six
panics on 0.31. A clean control run is exactly what a *broken* build already produces here.

### Setup

| Item | Value |
|---|---|
| Host | darwin 25.6.0 (`25G83`), Node v22.23.1 |
| Snapshot | `~/.gmax/scratch/lancedb-snap-20260825`, APFS clone of the live store, 2026-08-25 19:20, 12 GB |
| 0.38 side | second APFS clone `lancedb-b3-20260825`; `cp -c -R` took **0.155 s** and consumed 0 bytes |
| Scratch install | `~/.gmax/scratch/lancedb-0.38.0-beta.3` — `@lancedb/lancedb` + `@lancedb/lancedb-darwin-arm64` both `0.38.0-beta.3`, `lancedb.darwin-arm64.node` 230,881,472 B; `apache-arrow` 18.1.0 |
| 0.31 side | repo pnpm tree, `@lancedb/lancedb` 0.31.0 → lance 8.0.0 (crates.io) |
| Store under test | 352,198 rows (4,294 scoped to the gmax repo), 29 schema fields, `vector` dim 384, dataset version 250820, indices `content_idx` (FTS) + `path_idx` (BTree) |

The live store also carries **~140 empty `_indices/<uuid>/` directories** — orphans from past
drop-and-rebuild cycles. They hold no bytes but are inode clutter; the soak's
`optimize({cleanupOlderThan: new Date(), deleteUnverified: true})` collected all of them. Worth a
`doctor` line item.

### Step 1 — both engines open the snapshot

Read-only probe, identical under both engines: 352,198 rows, version 250820, 384-d vectors, both
indices listed, FTS `"VectorDB"` scoped → 20 hits with the same top-20 ids, exact vector search →
same top-20, `indexStats` 348,704 indexed / 3,494 unindexed. beta.3 **adopted the 0.31-authored FTS
index as-is** — no migration, no rebuild, no prompt.

One divergence, and it matters:

| `stats().totalBytes`, same dataset | 0.31 / lance 8 | beta.3 / lance 11 |
|---|---:|---:|
| pre-soak | 10,191,019,883 | 11,621,967,233 (**+14.0 %**) |
| post-soak | 10,073,446,686 | 11,539,369,428 (**+14.6 %**) |

`totalBytes` is the denominator of the `bloatRatio > 2.0` test in `vector-db.ts:1349` and of
`doctor.ts:245`. Under lance 11 the same physical footprint reads ~12 % less bloated, so the
compaction trigger fires later. Phase 1 should recalibrate that threshold rather than inherit it.

### Step 2 — API surface

All 18 `table.`/`db.` methods `vector-db.ts` calls are **signature-identical** between 0.31 and
beta.3: `add`, `addColumns`, `countRows`, `createIndex`, `delete`, `dropIndex`, `indexStats`,
`listIndices`, `optimize`, `query`, `schema`, `stats`, `update`, `version`, `openTable`,
`createTable`, `dropTable`, `close`. `OptimizeOptions`, `IndexOptions`, `IndexConfig`,
`IndexStatistics`, `TableStatistics`, `OptimizeStats` and `IvfFlatOptions` diff clean.

Two widenings, both backward-compatible: `addColumns` accepts one extra union member, and
`FtsOptions.baseTokenizer` moved to a `BaseTokenizer` alias that adds `"icu"` / `"icu/split"`.
`peerDependencies.apache-arrow` is `>=15.0.0 <=18.1.0`; the repo's 18.1.0 sits at the top of it.

Both engines emit the same `_score` autoprojection deprecation warning. `searcher.ts:576` already
selects `_score` explicitly (`FTS_COLUMNS`), so gmax is not exposed when that default flips.

### Step 3 — soak (12 qualifying cycles, 55 fragments each)

```
panicCount 0   rebuildFailureCount 0   correctnessMismatchCount 0
```

| | |
|---|---|
| Per-cycle optimize latency (s) | 306.5, 359.4, 142.3, 129.6, 138.8, 151.9, 144.0, 153.6, 186.0, 427.1, 178.1, 169.5 |
| p50 / p95 / max | 153.6 s / 427.1 s / 427.1 s |
| Wall clock | 19:24 → 20:05 PDT, 41 min |
| Process RSS | 832 – 1,606 MB |
| Fragments | 56 → 2 every cycle; final 352,253 rows in 2 fragments |
| Disk | 57 GiB free → 25 GiB low-water → 41 GiB after final cleanup; clone peaked ~23 GB |

Cycle 1 (306 s) absorbed the snapshot's 84-fragment backlog; cycle 10's 427 s outlier coincided
with the 25 GiB disk low-water mark. Steady state is ~140–190 s.

`zprint data.kalloc.1024` inuse: **291,014** at 19:17 (the incident doc's sample, three minutes
before the clone) → **306,226** at 20:06. That is +15,212 elements (~14.9 MiB) over 49 min, about
310 elts/min, against the documented idle drift of 8,355 elts / 65 min ≈ 128 elts/min. Roughly
**2.4× idle drift, no burst** — the kernel-zone incident's signature was ~450×. Within the band
Risk 4 asked for.

### Step 4 — cross-version read matrix

| Store written by | Opened with | Data | FTS query | Notes |
|---|---|---|---|---|
| 0.31 / lance 8 | beta.3 | ✅ | ✅ | index adopted as-is, no rebuild |
| beta.3, FTS incrementally merged over 12 cycles | 0.31 | ✅ v251539 | ✅ | top-5 ids identical |
| beta.3, **full FTS rebuild** (drop + create) | 0.31 | ✅ v251541 | ✅ | term *and* phrase queries identical |
| lance-11-touched store, 0.31 drops + recreates FTS | 0.31 | ✅ | ✅ | 16.6 s wall, index back to 1.3 GB |

Phrase queries (`"createFTSIndex"`, `"drop and rebuild"`, `"vector db"`) returned byte-identical
id lists across both engines against the lance-11-authored index, so positions survive the format
round trip. **Risk 1 is not reproduced**: rollback to 0.31 needed neither an FTS drop nor a
snapshot restore.

### Step 5 — FTS index size (unexpected)

Same 352,253 rows, same `withPosition: true`, full rebuild each time:

| Author | `part_*_invert.lance` | Directory |
|---|---:|---:|
| 0.31 / lance 8 | 1,373,263,857 B | 1.3 GB |
| beta.3 / lance 11 | 216,176,702 B | 235 MB |

**6.3× smaller** with identical term and phrase results. lance 11's incremental *merge* still lands
at ~1.3 GB — only the full rebuild is compact. If this holds on the fix-bearing build it directly
shrinks the compaction volume implicated in the kernel-zone incident, which would be the strongest
argument for the upgrade after the panic fix itself. Treat it as unconfirmed until Phase 1 runs
`pnpm bench:oss` against a lance-11-authored index — a 6× drop in a positional index is large
enough to want recall evidence behind it.

### Artifacts

`~/.gmax/scratch/`: `soak-b3.jsonl` (per-cycle records), `soak-b3.log`,
`matrix-6a-031-reads-b3.json`, `matrix-6b-b3-rebuild.json`,
`matrix-6c-031-reads-b3rebuilt.json`, `matrix-6d-031-rebuild.json`, `probe/probe.mts`,
`probe/phrase.mts`. The snapshot `lancedb-snap-20260825` and the beta.3 scratch install are
retained; the beta.3 working clone was deleted after the matrix completed.

Caveat on the probe scripts: their `ms` field is computed before the awaited call and is always 0.
Timings quoted above come from the soak harness and `/usr/bin/time`, not from that field.

## Version History

- **2026-08-26T03:40:00Z** Shipped without the remaining phases. Vendored the fix-bearing beta.10 CI build via postinstall; the beta.10 soak and panic-repro port were stopped mid-run and not resumed.

- **2026-08-26T03:15:00Z** Phase 0 ran as a lance-11 control on beta.3. Corrected the npm-
  availability facts: beta.6–beta.10 are unpublished on npm (GitHub release assets only), the
  newest published prerelease is `0.38.0-beta.3` on lance `11.0.0-beta.16`. Control results:
  0 panics / 0 correctness mismatches over 12 qualifying cycles, all 18 API call sites unchanged,
  bidirectional format compatibility confirmed (Risk 1 not reproduced), `totalBytes` +14 % under
  lance 11 (bloat-threshold recalibration needed), full-rebuild FTS index 6.3× smaller.
- **2026-08-26T02:05:00Z** Scoped. Fix location pinned to lance v11.0.0-beta.22 / lancedb
  0.38.0-beta.6+; stable not yet published; FTS v2 format identified as the rollback constraint.

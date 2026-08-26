---
type: doc
status: active
created: 2026-08-26T02:20:00Z
updated: 2026-08-26T02:20:00Z
surfaces:
  - daemon
  - store
  - release
domain: retrospective of the 2026-08-25 triage session — four releases, quarantine lifted, five defects closed
audience: internal
related_docs:
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
  - docs/known-limitations.md
  - docs/plans/lancedb-0.38-upgrade.md
  - docs/plans/lance-fts-merge-upstream.md
summary: What was found on entry, what shipped in v0.26.19–v0.26.22, the evidence behind each fix, and what is left.
---

# 2026-08-25 Release Triage — Retrospective

## State on entry

The session opened on a working tree that was clean, with two releases already cut that morning
(v0.26.17, v0.26.18) by another session, and a queued resume prompt whose only remaining step was
"install macOS 26.6.2". The host had in fact been updated two days earlier. Nobody had recorded it.

| Fact | Status on entry |
|---|---|
| Host | macOS 26.6.2 / `25G83`, booted 2026-08-23 19:55 — **not in the incident report** |
| Fourth kernel panic | 2026-08-21 16:24, still on `25F84`, `data.kalloc.1024` at 20 G — **not in the incident report** |
| Quarantine | `~/.gmax/autostart-disabled` present, yet a daemon had been running since 2026-08-24 03:45 |
| Store | 9 compactions in 26 h, 182 GB rewritten, driven by three git worktrees + one external root indexed as projects |
| v0.26.17 | GitHub release + tag exist; CI failed on a flaky test; never published to npm |
| Reader lease | `gmax remove` hung 4× (documented, unfixed) |
| Daemon | failed to exit on SIGTERM twice (documented as "mechanism not confirmed") |
| FSEvents | 290 `Events were dropped` on `platform` in three days, poll-mode fallback after every codegen run |

## What shipped

| Version | Change | Evidence it was needed |
|---|---|---|
| v0.26.19 | Autostart kill switch honored by every implicit spawn path (`ensureDaemonRunning`, `launchWatcher`) — `src/lib/utils/autostart.ts` | On 2026-08-21 the kernel-zone guard issued **8 CRITICAL stand-downs** (8.3 → 15.1 GiB). Each was undone by a restart; the host panicked at 20 G 90 min after the last. The switch was hook-only. |
| v0.26.19 | EPERM reader-lease markers swept via the `ps lstart` reuse check | Marker for pid 924 (started Aug 21) matched `/usr/libexec/rosetta/oahd`, user `_oahd`, started Aug 23 — a provable recycle that `process.kill(pid, 0)` reported as `EPERM` → "unknown" → immortal. |
| v0.26.19 | Incident report updated: panic 4, the update, 182 GB post-update rewrite, privileged baseline | See "Kernel zone" below. |
| v0.26.20 | `gmax llm` / `gmax repair --rebuild` name the kill switch instead of "failed to start daemon" | Follow-through on .19. |
| v0.26.21 | Codegen output ignored at the FSEvents source: `GENERATED_SOURCE_PATTERNS` shared between file policy and `WATCHER_IGNORE_GLOBS` | Drops-per-hour lined up 1:1 with Apollo iOS codegen bursts (~3,400 `*.graphql.swift`). The policy already discarded every one ("50 files, 0 reindexed"); the watcher still stat'd and delivered them. Real-`@parcel/watcher` test added. |
| v0.26.22 | Shutdown never hangs: `VectorDB.abortLeaseWaits()` fired before the drain; drain bounded at 30 s with the abandoned operation names and locked roots logged; 90 s hard-exit backstop on SIGINT/SIGTERM | Both hangs stalled at the operation drain after `Unwatched` (pool still reaping minutes later). Lease abort previously lived in `vectorDb.close()`, which ran *after* the drain that could be waiting on it. |

Each release passed the full gate (1112 → 1119 tests, both typechecks, Biome, prod audit,
tarball leak audit) and restarted the daemon with an IPC-confirmed version.

Also: quarantine file removed after the fix landed (so the file now means what it says); the
v0.26.17 GitHub release annotated as unpublished; the resume prompt consumed.

## Kernel zone — the accidental soak

The worktree churn was, unintentionally, the stress test the incident report said to wait for:
~182 GB of whole-store compaction on `25G83`, across 45 h uptime. Result:

| Time (`25G83`) | `data.kalloc.1024` in use | Note |
|---|---|---|
| 17:15 | 274,985 (~269 MiB), cur == max | privileged baseline |
| 18:12 | 282,659 (~276 MiB), cur == max | +7.5 MiB/h across four daemon restarts and a 13-project catchup — inside the ~4.5–9 MiB/h drift that continues with gmax stopped |

For contrast: 4.31 GiB on `25F84` nine hours before that day's panic, and a ~2 GiB/h burst regime.
The 2026-08-25 01:51 jetsam report on `25G83` shows `APFS_4K_OBJS` as the largest zone, not
`kalloc.1024`, and a Virtualization VM as the largest process. One host, two days — not a
controlled soak — but the bounded-usage evidence the Decision section asked for.

Panic 4's backtrace has no EndpointSecurity or APFS frame; the panicked task was `zsh`. APFS moved
2811.121.1 → 2811.160.7 with the update.

## Corrections to what was believed

- The Aug 24 03:45 revival was four daemons launching in the same second, ~22 h *before* the
  worktree adds. The worktrees amplified the churn; they did not break the quarantine.
- "Four worktrees" was three worktrees plus `furni` on the external volume.
- The reader-lease bug explains the CLI `gmax remove` hangs (daemon down, direct path). It does
  **not** explain the daemon's SIGTERM hang: the daemon-side remove is a plain write-gated
  `table.delete`, and the lease wait has a 10 s deadline. Which operation failed to settle is
  not identifiable from the log — the v0.26.22 timeout line exists so that next time it is.
- The stale-FTS forced optimize is no longer warranted: `_indices` fell to 2.7 GB from ~5–6 GB as
  a side effect of the nine compactions.

## Upstream

[lance#8310](https://github.com/lance-format/lance/issues/8310) (the FTS merge panic) was closed
as completed on 2026-08-23 by [lance#8312](https://github.com/lance-format/lance/pull/8312) after
a third party reproduced it in 4 s. The fix is in lance `v11.0.0-beta.22` → lancedb
`0.38.0-beta.6+`. No stable lancedb release has it; `0.37.1` is on lance 10. Scoped in
[`plans/lancedb-0.38-upgrade.md`](plans/lancedb-0.38-upgrade.md): store-clone soak now, cutover on
stable 0.38.0, 7-day live canary, FTS-v2 format identified as the rollback constraint.

## Outstanding

1. Kernel-zone samples at end-of-day and 24 h (~17:15 2026-08-26). Needs Touch ID.
2. Confirm zero FSEvents drops through the next platform codegen run.
3. `lancedb-0.38-upgrade` Phase 0 — awaiting a go, since it is bulk APFS churn on a clone.
4. If a `shutdown drain timed out` line ever appears, it names the SIGTERM root cause.
5. `docs/` is gitignored while four docs files are tracked; new docs need `git add -f`.

## Process notes

- Three parallel agents on disjoint files (lease fix, autostart fix, incident doc) produced three
  clean diffs in ~7 minutes; the doc agent's independent log read surfaced the eight stand-downs.
- `dotmd new` blocks on stdin without a TTY; write the file directly and let `dotmd plans` pick
  it up.
- `sudo` works through Touch ID from this harness (`/etc/pam.d/sudo_local`) — `sudo -n` does not.

## Version History

- **2026-08-26T02:20:00Z** Written at the end of the session.

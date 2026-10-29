---
type: plan
status: historical
created: 2026-10-28
updated: 2026-10-28
parent_plan: docs/plans/gmax-delivery.md
related_docs:
  - CLAUDE.md
  - AGENTS.md
summary: Historical project status and incident context relocated from the architecture guide.
---

# Architecture and operations history

These excerpts were moved out of `CLAUDE.md` on October 28, 2026. They preserve
what that guide previously reported, including relative wording such as “now,”
“current,” and “latest.” They are historical source text, not fresh verification,
new authorization, or an assertion of the current checkout or deployment state.
The [delivery plan](gmax-delivery.md) owns current status and selected work.
Durable architecture, procedures and safety rules remain in `CLAUDE.md`.

## Completion and FTS status

> under that restriction. Do not resume unfinished CPU changes while editing docs.
>
> For explicitly approved FTS catch-up, use [the P3 runbook](../runbooks/p3-fts-catch-up.md).
> Two content-bounded batches are normal. Snapshot9803 already completed the latest
> catch-up with zero pending rows. Do not confuse later profiling guards with FTS
> failure or rerun the completed operation. Host/process limits, rollback,
> owned-process cleanup, local-only checks and the large-model restriction remain.

## Local-only authorization provenance

> Approved instruction, 2026-10-23: "DO NOT run check anywhere other than local"
> and "stop using remote builders".

## Reliability queue and release status

> The current reliability queue is in `docs/future-sessions.md` (local internal notes); tracked `docs/known-limitations.md` records consumer dependency audit caveats. Consume the latest runlist handoff before reusing old release or soak instructions. The ordered reliability fixes cover native cache wiring, consumer packaging, query deadlines/bounded scans, external-store MCP/status and obsolete fallback removal. These shipped in v0.26.44; longer memory cycles remain an observation task. Embedding migration and recall experiments remain measurement-gated.

## Watch-lease host measurements

> (`src/lib/daemon/watch-leases.ts`, persisted in `~/.gmax/watch-leases.json`). It used to
> subscribe to every indexed project for its whole life; with 14 registered projects that meant
> ~300 cold worker spawns, 129 FSEvents overflows and 32 catchup scans a day for sessions that did
> not exist, and it was a large part of the memory pressure that froze the host.

## Hook release history

> These hook/installer repairs ship in v0.26.51 and require a plugin refresh after upgrading.

## Systemd release and commissioning status

> 0.26.98 keeps a systemd-owned daemon's recycle/restart inside its unit. From
> 0.26.99, default-home startup recognizes user-config `gmax.service` /
> `hetchy-gmax.service` and starts through systemctl. Failed or unverifiable service
> ownership cannot fall through to a detached daemon or watcher; read-only startup
> cannot start a normal unit. P3 installation and service/cgroup acceptance are
> recorded by the platform host plan and `docs/future-sessions.md`.

## ANN qualification outcome

> One table (`chunks`), all projects share it, scoped by path prefix (`/absolute/path/to/project/`). A path btree accelerates scoped exact search. IVF_FLAT is flag-gated by `GMAX_ANN=1` and disabled by default because the production recall soak failed its acceptance threshold. The containment release schedules no maintenance loop and no speculative embedding warmup. Historical maintenance behavior is covered by tests with the immutable production policy explicitly mocked off.

## Compaction incident and regression receipt

> Compaction must take its snapshot **after** `drainWrites()`, and reopen the table on each retry. In the October 2 disk incident, opening before the drain let an outstanding delete invalidate the snapshot; all five retries reused it and stranded about 70 GB of full fragment copies. `optimize()` now caps calls at two attempts, updates the prune cutoff each time to include earlier failed copies, and checks fresh available space (not the cached pressure level) against twice the logical table size plus `DISK_CRITICAL_BYTES`. This is an estimate with overhead margin, not a reservation against other applications writing to disk. Regression coverage includes a native Lance delete/compact/reopen test in a temporary store. Do not reproduce the incident by rewriting the live store.

## Containment and recovery delivery status

> The containment release disables all full-table optimization and scheduled maintenance, including force/doctor/startup paths, before native setup. There is no production override. Existing retained copies remain until a separately verified exclusive prune-only recovery. Prune-only recovery and its pinned Python helper ship through the explicit `gmax recover` path; live cleanup still requires fresh admission and exclusive ownership. Persistent host safety stops and existing quarantine must survive hook launches, recycle, installation and explicit daemon startup; do not remove them as routine troubleshooting. Legacy compaction regressions use a test-only policy mock; that does not authorize live compaction.

## Diagnostic deployment status

> and ownership rules are unchanged. This diagnostic change must be released and
> installed before it can explain new live incidents; old events cannot be backfilled.

## Cache footprint measurements and test receipt

> `lancedb.connect()` without a `Session` gets a 6 GB index cache and a 1 GB metadata cache, held
> for the connection's life. The daemon reached a 4 GB footprint (9.6 GB peak) that way, nearly all
> native malloc. `VectorDB` now connects with a Session capped at 1 GB / 256 MB
> (`GMAX_LANCE_INDEX_CACHE_MB`, `GMAX_LANCE_METADATA_CACHE_MB`). Pass the Session in `ConnectionOptions.session`: SDK 0.38 silently ignores the legacy positional third argument despite retaining its type declaration. The native regression test verifies queries populate the measured session; the whole index directory is
> ~650 MB. `VectorDB.cacheSizeBytes()` reports what the caches currently hold.

## Recycle incident measurements

> The recycle watermark (`GMAX_DAEMON_RSS_WATERMARK_MB`, 2560) is compared against the physical
> footprint from `footprint -p` (`src/lib/utils/process-footprint.ts`), not RSS: RSS read 469 MB
> while the footprint was 4 GB, because compressed and swapped pages drop out of RSS. The footprint
> trigger waits for 30 min of uptime so a fresh daemon cannot recycle in a loop. Once a recycle is
> due it is re-checked every heartbeat, and after `GMAX_DAEMON_RECYCLE_FORCE_AFTER_MS` (1h) it
> proceeds over in-flight project work (compaction is still waited out). One daemon ran 8 days past
> its 24h limit because some batch was in flight at every 5-minute probe.

## Upstream FTS panic fix history

> #### The FTS optimize panic guard — fixed upstream, guard kept as a tripwire
>
> `table.optimize()` on lance ≤ 11.0.0-beta.21 could panic inside the incremental FTS merge
> (`builder.rs:856`, [lance#8310](https://github.com/lance-format/lance/issues/8310)). Fixed by
> [lance#8312](https://github.com/lance-format/lance/pull/8312) in lance `11.0.0-beta.22`.

## Lance overlay and pin release history

> gmax pins `@lancedb/lancedb 0.39.0` GA as a development dependency and copies its unmodified JS runtime into `dist/vendor/lancedb` at build time (lance `=12.0.0`, which carries the fix). Exact optional platform packages supply the native binary. This prevents npm consumers from resolving the SDK's unused old transformers/openai provider pins; root runtime dependencies, license and provenance are checked during the build. The
> native binary comes from the `@lancedb/lancedb-darwin-arm64` platform package like any other
> dependency. From 0.26.23 through 0.26.26 the pin was `0.38.0-beta.3` (lance beta.16, pre-fix) with
> `scripts/postinstall.js` overlaying a fix-bearing beta.10 build from `~/.gmax/vendor/`; that
> overlay is gone, so the postinstall is a plain notice again and needs no `allow-scripts` grant.
>
> The drop-and-rebuild mitigation in `vector-db.ts` stays. After the upgrade a panic is a regression
> to report upstream, not an expected cost. Preserve: `createFTSIndexUnsafe()` **throws** on terminal
> failure; `disabling auto-rebuild until an optimize succeeds` is transient.

## FTS repair introduction release

> `gmax repair --fts` (0.26.96, ping capability `ftsBuild: 1`) is the one narrow way to build it.

## Abandoned scratch-file incident

> #### Abandoned `.tmp*` files are the other half of that panic's cost
>
> Every killed optimize — FTS panic, daemon restart mid-compaction, OOM — strands the scratch file
> Lance was staging the new fragment into. These never get collected: they hold no manifest entry, so
> `optimize({deleteUnverified: true})` cannot prove they are garbage, and the leading dot hides them
> from a plain `ls`. Three of them (7.3 GB, up to 2.5 months old) held this store at a 2.1x
> disk/logical ratio that the bloat-retry in `runMaintenance` re-measured and re-optimized against
> every cycle without ever reclaiming a byte.

## Pending-project abort release history

> was (normally `pending`), so the next daemon resumes it; before 0.26.96 the abort marked it `error`.

## Watcher evidence deployment status

> The source change must be deployed before relying on this evidence in live service.

## Batch-lock deadlock release history

> batch that is waiting on them. Before 0.26.96 that deadlock left a retried project `pending` forever,
> with `indexPendingProject start` logged but no `[index] Root:` or `Unwatched` line after it.

## Worker spawn measurements

> (`GMAX_WORKER_SCALE_UP_WAIT_MS`). Before this, a 6-file batch cold-started 3–4 workers that were reaped a minute later, ~300 times a day

## Worker threshold qualification claim

> - Workers over 1536MB RSS for consecutive post-task samples are recycled; the threshold is calibrated above measured MLX and ONNX p95 steady state

## Embedding performance measurement

> If MLX unavailable -> ONNX CPU in-process (~5x slower)

## Read-verbs transition verification

> never open a second reader. The one-release transition allowance was removed after verifying
>   the running v0.26.43 daemon advertises `capabilities.readVerbs: 1`.

## Similarity dependency migration history

> - `src/lib/workers/colbert-math.ts` — MaxSim + cosine over ColBERT vectors. Uses `inner` from
>   `numkong` (simsimd's maintained successor; simsimd was dropped in v0.26.7 because it pulled
>   `mathjs` as an optional dependency and was silently falling back to its JS path)

## Override migration audit incident

> A migration to that field silently un-pinned `mathjs` and reintroduced two high advisories that
>   the release CI audit gate then blocked on.

## Native overlay release provenance

> at the `@lancedb/lancedb-darwin-arm64` platform package under the global grepmax. A path under
> `@lancedb/lancedb/dist/` means a stale vendored overlay from the 0.26.26-era `~/.gmax/vendor/`
> mechanism is still in place; remove that install and reinstall.

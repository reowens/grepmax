---
type: doc
status: active
created: 2026-08-04T20:50:29Z
updated: 2026-08-25T17:30:00Z
surfaces:
  - host
  - store
  - daemon
domain: macOS APFS and EndpointSecurity kernel-zone exhaustion incident
audience: internal
summary: Investigation and remediation record for recurring data.kalloc.1024 kernel panics on macOS 26.5.2, and the first bounded-usage evidence from macOS 26.6.2.
related_plans:
  - archived/lancedb-fts-panic-remediation.md
related_docs:
  - docs/2026-08-04-performance-review.md
  - docs/known-limitations.md
current_state: >
  Four panics on macOS 26.5.2 build 25F84 exhausted data.kalloc.1024 at 19-20 GB. Panic 4
  (2026-08-21) came four days after panic 3 on the identical build, and its logs show the new
  kernel-zone guard working exactly as designed and being defeated anyway: the daemon stood itself
  down eight times between 8.30 and 15.14 GiB and was restarted every time, because the auto-start
  kill switch is hook-only. The host was updated to macOS 26.6.2 build 25G83 (Darwin 25.6.0,
  APFS 2811.160.7) on 2026-08-23. On the new kernel the daemon was revived anyway and rewrote the
  whole store nine times in 27 hours - roughly the same class of write load that detonated 25F84 -
  and data.kalloc.1024 has stayed at ~269 MiB after 45 hours instead of climbing into the gigabytes.
  That is the first bounded-usage evidence the Decision section asked for, from one host over two
  days.
next_step: >
  Keep sampling data.kalloc.1024 on 25G83 at the one-hour, end-of-day, and 24-hour marks against the
  274,985-element privileged baseline recorded 2026-08-25 17:15, and re-sample after Docker,
  Parallels, and Simulator come back one category at a time. The stale-FTS forced optimize is no
  longer warranted: _indices is down to 2.7 GB from ~6.0 GB, reclaimed as a side effect of the nine
  compactions. The autostart fix (src/lib/utils/autostart.ts) shipped in v0.26.19, so a guard
  stand-down can no longer be undone by the next `gmax add`.
---

# macOS Kernel-Zone Panic Incident - 2026-08-04

> **Status 2026-08-25.** Four panics, all on `25F84`. The host is now on macOS 26.6.2 (`25G83`) and
> the zone has stayed bounded through two days of heavy write load. See
> [Panic 4 And The 26.6.2 Update](#panic-4-and-the-2662-update-added-2026-08-25). The narrative
> below is preserved as written at each revision; where it says "twice", read "the first two".

## Executive Summary

The Mac panicked twice because the kernel's `data.kalloc.1024` allocation zone grew to
approximately 20 GB and exhausted the zone map. Both panics occurred on macOS 26.5.2 build
`25F84`, Darwin 25.5.0, and have the same APFS and EndpointSecurity backtrace. The panics were
not caused by ordinary user-process memory pressure: compression and swap remained healthy,
and the failed resource was wired kernel-zone memory.

The August 4 panic occurred 16 seconds after a filesystem-heavy LanceDB 0.31 soak completed.
That workload is a credible accelerator or final trigger, but it is not a sufficient root-cause
explanation. Jetsam reports show the same kernel zone growing from 5.3 GB on July 28 to 19.7 GB
before the first panic, and the first panic occurred before this LanceDB 0.31 experiment.

The strongest remediation is the available macOS 26.6 update, which replaces the affected
kernel and APFS build. No third-party kernel extension or EndpointSecurity system extension was
found. Little Snitch and Tailscale are active network extensions only. Docker virtualization was
active during the first panic but absent during the second, so it can add filesystem pressure but
is not required for the failure.

## Impact

- Two forced host restarts and loss of in-memory session state.
- Automatic removal of the approved `/var/folders/.../T/opencode` soak snapshot and evidence
  files during reboot.
- Additional high-churn APFS soaks are blocked.
- ~~Live LanceDB 0.31 deployment is blocked.~~ Superseded 2026-08-05: 0.31 shipped in v0.26.6
  after the panic was shown to be a version-invariant upstream defect. See the LanceDB section
  below.
- The host remains at risk until the OS is updated and kernel-zone growth is shown to remain
  bounded under normal work.

## Host And Software State

| Item | Observed value |
|---|---|
| Hardware | Mac16,7, Apple silicon |
| Affected OS | macOS 26.5.2, build `25F84` |
| Affected kernel | Darwin 25.5.0, `xnu-12377.121.10~1/RELEASE_ARM64_T6041` |
| Available update | macOS Tahoe 26.6, build `25G72`, recommended, restart required |
| **Installed 2026-08-23** | macOS 26.6.2, build `25G83` |
| **Current kernel** | Darwin 25.6.0, `xnu-12377.161.14~5/RELEASE_ARM64_T6041` |
| **Current APFS** | `com.apple.filesystems.apfs` 2811.160.7 (was 2811.121.1 in the `25F84` traces) |
| Internal APFS container | 994.7 GB total, 755.6 GB used, 239.1 GB unallocated |
| Internal APFS container (2026-08-25) | 994.7 GB total, 912.5 GB used (91.7%), 82.2 GB unallocated |
| Root filesystem | 223 GiB available at investigation time |
| Power | AC power, battery 100% |
| Time Machine | No destination configured; no local snapshots listed |
| Device management | No DEP or MDM enrollment |
| Third-party kexts | None loaded |
| Third-party system extensions | Tailscale 1.102.1 and Little Snitch 6.4.1 network extensions |
| Other relevant software | Docker Desktop 4.85.0; Parallels Desktop 26.3.3 |
| Current fresh-boot zone sample | `data.kalloc.1024` had 15,826 live elements, about 15.5 MiB |

## Incident Timeline

| Time | Event |
|---|---|
| 2026-07-28 21:29 PDT | Jetsam report records `data.kalloc.1024` as largest zone at 5.3 GB. |
| 2026-07-29 00:36 PDT | Zone reaches 10.2 GB. |
| 2026-07-29 07:08 PDT | Zone reaches 11.2 GB. |
| 2026-07-30 08:59 PDT | Zone reaches 11.4 GB. |
| 2026-08-01 12:12 PDT | Zone reaches 11.5 GB; Docker's Apple Virtualization process is the largest user process. |
| 2026-08-03 14:23 PDT | Zone reaches 19.7 GB before the first retained panic. |
| 2026-08-03T22:25:34Z | First panic exhausts the zone near 19 GB and 20.9 million elements. |
| 2026-08-04T13:05:15Z | Isolated LanceDB 0.31 soak emits its successful final summary. |
| 2026-08-04T13:05:32Z | Second panic exhausts the zone near 20 GB and 21.2 million elements. |
| 2026-08-04T20:47Z | Fresh-boot `zprint -t` sample shows 15,826 live 1 KB elements. |
| 2026-08-04T20:44Z | Software Update offers macOS 26.6 build `25G72`. |
| 2026-08-04 - 2026-08-17 | macOS update is **not** installed. Host stays on `25F84`. |
| 2026-08-11 03:53 EDT | Zone at 0.72 GiB after 7 days uptime; drift ~4.5 MiB/hour. |
| 2026-08-16 18:14 EDT | gmax LanceDB writer (`node` PID 88131) begins the sampled write window. |
| 2026-08-17 00:31 EDT | Zone at 1.37 GiB. Drift still flat. |
| 2026-08-17 02:55-03:44 EDT | `bsdtar` under ChatGPT/`com.openai.codex` dirties 2.15 GB over 49 min. |
| 2026-08-17 06:30 EDT | Writer report closes: **549.76 GB dirtied over 12.3 h at 12.45 MB/s**. |
| 2026-08-17 08:50 EDT | Zone at **17.89 GiB**. +16.5 GiB in 8h19m, ~450x the baseline rate. |
| 2026-08-17 14:56:10 EDT | Third panic exhausts the zone at 20 GB / 20,988,560 elements. |
| 2026-08-21T06:55:35 | Kernel-zone guard warns at **4.31 GiB** (4,522,280 elements). Last guard line before `daemon.log` rotates. |
| 2026-08-21T09:05:35 | Guard trips its 8 GiB ceiling at 8.30 GiB and stops the daemon. Something restarts it. |
| 2026-08-21T09:05-14:57 | Guard trips seven more times, 8.60 -> 15.14 GiB. Every stand-down is undone by a restart. |
| 2026-08-21 16:24:30 -0700 | **Fourth panic** exhausts the zone at 20 G / 21,123,392 elements, still on `25F84`. |
| 2026-08-23T19:48:40 | Daemon shuts down cleanly ahead of the update. |
| 2026-08-23 19:55:51 -0700 | Host boots **macOS 26.6.2 (`25G83`)**, Darwin 25.6.0, APFS 2811.160.7. |
| 2026-08-24T03:45:04 | Four concurrent launches revive the daemon despite the quarantine file. |
| 2026-08-24T03:50 - 2026-08-25T06:33 | Nine full compactions; `freed` totals 182,382 MB. |
| 2026-08-25 01:51:44 -0700 | Jetsam on `25G83`: whole zone map 2.49 GiB; largest zone is `APFS_4K_OBJS`, not `data.kalloc.1024`. |
| 2026-08-25 17:15 -0700 | `sudo zprint` after ~45.5 h uptime: 274,985 live elements, ~269 MiB. |

The first failing boot lasted approximately 17 days. The second lasted 14 hours and 39 minutes.
The third lasted 13 days, 5 hours, 50 minutes. That variance is not random: the zone is flat until
a sustained heavy-write window appears, then climbs roughly three orders of magnitude faster.

## Write Amplification Is The Trigger (added 2026-08-17)

Panic 3 resolves the attribution question the first two reports left open. Two jetsam samples
bracket the growth:

| Sample | `data.kalloc.1024` | Rate since previous |
|---|---:|---|
| 2026-08-10 21:32 EDT | 0.67 GiB | - |
| 2026-08-11 03:53 EDT | 0.72 GiB | ~8 MiB/hour |
| 2026-08-11 11:27 EDT | 0.76 GiB | ~6 MiB/hour |
| 2026-08-17 00:31 EDT | 1.37 GiB | ~4.5 MiB/hour |
| 2026-08-17 08:50 EDT | **17.89 GiB** | **~2.0 GiB/hour** |

The leak is not a steady drip. It is near-dormant under ordinary use and violent under sustained
filesystem writes.

`node_2026-08-17-063018_*.diag` identifies the writer. All 817 microstackshot samples (100%) are in
the same stack:

```text
thread_start -> _pthread_start -> lancedb.darwin-arm64.node (x4 frames) -> write
```

- PID 88131, `/Users/USER/*/node`, parent reparented to launchd, coalition `com.mitchellh.ghostty`.
- **549.76 GB of file-backed memory dirtied over 44,172 s (12.3 h), 12.45 MB/s sustained.**
- Footprint grew 1623 MB -> 4844 MB during the 5-minute sample window.

That is the gmax daemon's LanceDB writer, and the volume is explained by the daemon's own log:

| Event (Aug 16-17, `daemon.log`) | Count |
|---|---:|
| `[watch:platform] Batch complete` | 4,321 |
| `[daemon:platform] Reindexed` | 3,844 |
| `[vectordb] optimize` / `Compacted` | 43 each |
| `[vectordb] Fragment threshold exceeded` | 31 |
| `[vectordb] Bloat detected after optimize` | 3 |
| `[daemon:platform] Watcher error` | 174 |

Forty-three full-table compactions of a 16 GB store is 550-690 GB of rewrite - which matches the
measured 549.76 GB almost exactly. Compaction frequency is also accelerating: 6 trips on Aug 14,
30 on Aug 15, 63 on Aug 16, 54 on Aug 17.

### Which caller was compacting

Not `compactIfNeeded`. `FRAGMENT_COMPACT_THRESHOLD` is 400 and the store carries 29 small
fragments, so that path never fired. The driver is `runMaintenance`'s 5-minute timer, which
re-optimizes whenever the write epoch has moved since the last pass. On a host where `platform`
(206k chunks, 63% of the store) is edited continuously, the epoch has always moved, so the
5-minute tick rewrote the whole store indefinitely. Neither caller had any rate limit.

### Correction: the GraphQL codegen is not the churn source

An earlier revision of this section blamed `platform`'s 3,346 tracked `*.graphql.swift` Apollo
codegen files, on the strength of 10,399 mentions in `daemon.log`. That was wrong, and the store
disproves it: a `path LIKE '%BeyondGraphQL%'` count returns 19 rows, all from an unrelated test
file. `ProjectFilePolicy.classifyFile` already returns `excluded / "default ignore policy"` for
them, with no `.gmaxignore` involved.

The log mentions are real but misleading - `[watch:platform] Processing N changed files` lists
filenames *before* the policy filter drops them. Regenerating the codegen therefore costs watcher
and batch-processor overhead, but writes no vectors and fragments nothing. The reindex volume
comes from `platform`'s ordinary TypeScript, TSX, and Markdown sources.

### Mechanism, end to end

1. `platform` sources are edited continuously, so the store's write epoch never goes quiet.
2. `runMaintenance` fires every 5 minutes and, seeing a moved epoch, runs a full optimize.
3. Each optimize rewrites the whole store - 43 times in two days, and accelerating.
4. That is ~550 GB of writes at 12.45 MB/s sustained.
5. Every write traverses the APFS -> EndpointSecurity/AMFI/quarantine path that leaks 1 KB
   kernel objects on `25F84`.
6. `data.kalloc.1024` climbs 1.37 -> 17.89 GiB in 8 hours and exhausts the 18.9 GB zone map cap.

### Store composition

| Component | Size | Note |
|---|---:|---|
| `data/` | 10.0 GB | Logical size is 10.01 GiB - the data is **not** bloated. |
| `_indices/` | 6.0 GB | 7 non-empty dirs; 5 are ~1.2 GB stale FTS index copies. |
| `_versions/`, `_transactions/`, `_deletions/` | ~5 MB | Negligible. |

327,027 rows. The reclaimable 5 GB is stale index versions, not row data, so a reindex would be
the wrong tool - it would rewrite 10 GB of healthy data to reclaim index artifacts. `_indices`
also held **8,639 empty leftover directories**, removed 2026-08-17; every maintenance cycle's
`getDirectorySize` walk had been traversing all of them.

### What this does and does not change

- The **defect** is still Apple's. No user-space program should be able to exhaust a kernel zone
  by writing files, and the leak reproduces across unrelated workloads (`bsdtar` under Codex also
  ran heavily in the burst window).
- The **trigger volume** is ours, and unlike the kernel bug it is fixable today. gmax was the
  single largest write source on this host by a wide margin.
- Panic 3 does not implicate LanceDB 0.31; the live store was never upgraded and this store is
  running the shipped version. The problem is compaction *frequency* against an oversized shared
  table, not the engine.

## Panic 4 And The 26.6.2 Update (added 2026-08-25)

### The guard worked and was defeated anyway

Panic 4 landed 2026-08-21 16:24:30 -0700, four days after panic 3, on the same unpatched `25F84`.
The kernel-zone guard shipped on 2026-08-17 had been running the whole time, and its log is the
most useful thing in this section.

The 4.31 GiB warning is where the report asked us to look, at `daemon.log.prev` line 44361:

```text
2026-08-21T06:55:35 [daemon] WARNING: data.kalloc.1024 at 4.31GiB (4,522,280 elements) - macOS
kernel zone is leaking under write pressure. The daemon will stop itself at 8GiB. Only a reboot
reclaims this memory.
```

**There is no 8 GiB stand-down line after it in that file.** That absence is a rotation artifact,
not a guard failure: `daemon.log.prev` ends at `2026-08-21T07:00:20` because the log hit its 5 MB
rotation, and the stand-downs continue in the current `daemon.log`. Reading across the rotation, the
guard fired eleven times - three warnings and eight stand-downs:

| Time | Zone | Guard action |
|---|---:|---|
| 2026-08-21T06:55:35 | 4.31 GiB (4,522,280) | warn |
| 2026-08-21T07:55:36 | 6.53 GiB (6,845,445) | warn |
| 2026-08-21T09:00:35 | 7.76 GiB (8,133,109) | warn |
| 2026-08-21T09:05:35 | 8.30 GiB (8,708,256) | **stop** |
| 2026-08-21T06:52:29 | 8.60 GiB (9,022,687) | **stop** |
| 2026-08-21T11:55:08 | 10.22 GiB (10,714,905) | **stop** |
| 2026-08-21T12:04:05 | 10.39 GiB (10,890,356) | **stop** |
| 2026-08-21T13:08:56 | 12.81 GiB (13,427,443) | **stop** |
| 2026-08-21T13:28:23 | 13.55 GiB (14,212,927) | **stop** |
| 2026-08-21T13:47:26 | 14.49 GiB (15,198,968) | **stop** |
| 2026-08-21T14:57:19 | 15.14 GiB (15,877,556) | **stop** |

The 06:52:29 row is out of chronological order in the file - a concurrent daemon appending to the
shared log - so treat its position, not its reading, as unreliable.

Eight stand-downs in six hours, each one obeyed, and the zone still reached 20 G ninety minutes
after the last. The guard stops the daemon; it does not stop the daemon from being started again.
`~/.gmax/autostart-disabled` is checked only by the session-start hook, so every `gmax add`, MCP
session, or manual `gmax watch` walks straight past it and hands the kernel a fresh writer. This is
the one design defect the mitigation set still has, and panic 4 is what it costs. A fix is in the
working tree - see *Mitigations Shipped 2026-08-25*.

### The update

| Item | Before | After |
|---|---|---|
| `sw_vers` | macOS 26.5.2 (`25F84`) | **macOS 26.6.2 (`25G83`)** |
| `uname -v` | `Darwin ... 25.5.0 ... xnu-12377.121.10~1/RELEASE_ARM64_T6041` | **`Darwin Kernel Version 25.6.0: Fri Jul 31 19:17:26 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T6041`** |
| APFS | 2811.121.1 (from the panic backtraces) | **2811.160.7** |

`sysctl kern.boottime` reports `{ sec = 1787540151 }` - Sun Aug 23 19:55:51 2026 -0700 - and the
daemon logged a clean `Shutdown complete` at `2026-08-23T19:48:40`, seven minutes before the
restart. The APFS version came from `kmutil showloaded` and `apfs.kext`'s `Info.plist`, which agree
on 2811.160.7; `diskutil apfs list` prints no version string, only container geometry (disk3,
994.7 GB, 912.5 GB used, 91.7%).

### Post-update exposure was accidental, and that is what makes it useful

The quarantine file is still in place (`~/.gmax/autostart-disabled`, 172 bytes, dated Aug 17) and
still hook-only. At `2026-08-24T03:45:04` four daemon processes launched within the same second -

```text
Daemon started (PID: 66977, ...)   Daemon started (PID: 66992, ...)
Daemon started (PID: 66993, ...)   Daemon started (PID: 66994, ...)
```

- racing the singleton check, which resolved it by killing three. Over the next 27 hours another
session indexed four roots on the external volume: `/Volumes/External/furni-w6-a.f0kWDN/furni`
(`2026-08-24T11:21:06`), then the git worktrees `atlas-5-3-i` (`2026-08-25T02:13:54`),
`atlas-5-5cd` (`02:36:19`), and `atlas-5-4a-snapshot` (`05:16:19`), all unwatched again at
`05:32:24`.

That work drove nine full-table compactions:

```text
2026-08-24T03:50:56 [vectordb] Compacted: 192 frags -> 2, pruned 1079 versions, freed 15909.7MB
2026-08-24T11:23:48 [vectordb] Compacted: 129 frags -> 2, pruned  575 versions, freed 14568.3MB
2026-08-24T12:15:56 [vectordb] Compacted:  63 frags -> 2, pruned  202 versions, freed 12802.8MB
2026-08-24T18:19:04 [vectordb] Compacted: 402 frags -> 2, pruned 2341 versions, freed 14841.5MB
2026-08-24T22:37:46 [vectordb] Compacted: 402 frags -> 2, pruned 2166 versions, freed 14496.9MB
2026-08-25T03:08:19 [vectordb] Compacted: 255 frags -> 2, pruned  865 versions, freed 24018.6MB
2026-08-25T03:42:08 [vectordb] Compacted: 174 frags -> 2, pruned  365 versions, freed 29834.4MB
2026-08-25T06:00:44 [vectordb] Compacted: 107 frags -> 2, pruned  807 versions, freed 42279.2MB
2026-08-25T06:33:12 [vectordb] Compacted:  11 frags -> 2, pruned   41 versions, freed 13630.6MB
```

**182,382.0 MB - 182.4 GB - freed across nine whole-store rewrites of a 12 GB table in 26h42m.**
This is the same class of load that took the zone from 1.37 to 17.89 GiB in eight hours on `25F84`.
Nobody would have approved this run; it happened because the kill switch has the hole described
above. Having happened, it is a far better test than a cautious one would have been.

### The zone stayed bounded

| Sample | `data.kalloc.1024` | Context |
|---|---:|---|
| 2026-08-21T06:55:35 (`25F84`) | **4.31 GiB** / 4,522,280 elts | ~9.5 h before panic 4 |
| 2026-08-21T14:57:19 (`25F84`) | **15.14 GiB** / 15,877,556 elts | last guard sample before panic 4 |
| 2026-08-25 17:13:13 (`25G83`) | ~268 MiB / 275,057 elts | unprivileged `zprint`, ~45.3 h uptime |
| 2026-08-25 17:15 (`25G83`) | **~269 MiB** / 274,985 inuse | privileged baseline, ~45.5 h uptime |

The privileged sample is the baseline of record:

```text
$ sudo zprint data.kalloc.1024
zone name          elem size   cur size   max size   cur #elts  max #elts   inuse   alloc size  count
data.kalloc.1024        1024    275280K    275280K      275280     275280  274985         16K     16
```

`cur size == max size` - the zone has never exceeded its present high-water mark on this boot. The
unprivileged reading taken two minutes earlier (275,057 inuse) agrees to within 0.03%; unprivileged
`zprint` reports zero for the size and element columns and only `inuse` is meaningful there.

`JetsamEvent-2026-08-25-015144.ips`, the first jetsam captured on `25G83`, corroborates it from the
other direction:

| Field | Value |
|---|---|
| `zoneMapSize` | 2,674,884,608 (2.49 GiB, against an 18,899,582,976 cap) |
| `largestZone` | **`APFS_4K_OBJS`**, 693,731,328 (661 MiB) |
| `largestProcess` | `com.apple.Virtualization.Virtual` |

On every `25F84` jetsam in this report, `data.kalloc.1024` *was* the largest zone. On `25G83` it is
not even close - the whole zone map is smaller than `data.kalloc.1024` alone was at the first
warning on Aug 21, and the largest zone is an ordinary APFS object cache eight times smaller than
the earlier leak's warning threshold.

**This is the bounded-usage evidence the Decision section required**, and it is worth being precise
about its strength. It is one host, over two days, on a workload that happened rather than one that
was designed - not a controlled soak, no A/B against a held-back `25F84` machine, and no isolation
of Docker, Parallels, or Simulator, which stayed closed by default rather than by protocol. What it
does establish is that the specific failure mode - `data.kalloc.1024` climbing multiple GiB per hour
under sustained LanceDB compaction - did not reproduce under a load of the same shape carrying
roughly a third of panic 3's volume (182 GB vs 550 GB) spread over twice the wall time, so about a
sixth of the sustained rate. A run at panic-3 intensity has not been attempted and should not be.

### The 4-worktree indexing is now refused

Commit `4ef7c67` "Refuse to index git worktrees" (2026-08-25 05:54:42 -0700, released in v0.26.17
and v0.26.18) prevents the specific trigger. `blocked-add.log` shows it working on the first
attempt after release:

```json
{"ts":"2026-08-25T13:27:23.223Z","reason":"git_worktree",
 "attempted":"/Volumes/External/beyond-claude/worktrees/atlas-5-3-i", ...}
```

That closes one entry point, not the class. A worktree is now refused; a plain `gmax add` of any
other root still revives a daemon the guard has stood down.

Related: `docs/known-limitations.md`, *"A recycled PID makes a reader lease immortal and hangs every
exclusive operation"*. That defect is what makes `gmax remove` and `gmax repair --rebuild` hang on
this store, so the cleanup path for a wrongly-indexed root is itself unreliable - relevant here
because removing the four external roots is exactly the operation it blocks.

### Stale FTS copies: the forced optimize is no longer warranted

The 2026-08-17 revision deferred a forced full optimize to reclaim ~5 GB of stale FTS index copies,
on the grounds that a whole-store rewrite was the operation under suspicion. The nine accidental
compactions above did that work as a side effect:

| Measure | 2026-08-17 | 2026-08-25 |
|---|---:|---:|
| `_indices/` | 6.0 GB | **2.7 GB** |
| `chunks.lance/` total | ~16 GB | 12 GB |

At 2.7 GB there is no longer a ~5 GB reclaim on the table, so the deferred forced optimize is
cancelled rather than rescheduled. Ordinary throttled maintenance is now sufficient.

## Panic Signature

Both reports have the same failure class:

```text
zalloc[3]: zone map exhausted while allocating from zone [data.kalloc.1024],
likely due to memory leak in zone [data.kalloc.1024]
```

The August 4 report records:

```text
data.kalloc.1024  20G  0B free
21,191,280 elements allocated
Compressor: OK
Swap space: OK
Panicked task: pid 44169: opencode.exe
```

The kernel backtrace includes:

- `com.apple.iokit.EndpointSecurity(1.0)`
- `com.apple.driver.AppleMobileFileIntegrity(1.0.5)`
- `com.apple.security.quarantine(4)`
- `com.apple.filesystems.apfs(2811.121.1)`
- `com.apple.iokit.IOStorageFamily(2.1)`

The August 3 report has the same sequence and component versions. It exhausted approximately
19 GB with 20,948,320 elements and named `opencode.exe` PID 31547 as the panicked task.

The August 17 report exhausted 20 GB with 20,988,560 elements and again named `opencode.exe`
(PID 94302, 19,190 pages, 36 threads - a small task) as the panicked one. Its kext backtrace lists
`EndpointSecurity(1.0)` with `AppleMobileFileIntegrity(1.0.5)` and `security.quarantine(4)` as
dependencies; APFS and IOStorageFamily do not appear in the third trace, though the failing zone,
build, and kernel are identical. Compressor sat at 22% of its limit and swap was OK, so this was
again wired kernel-zone exhaustion rather than RAM pressure.

The August 21 report exhausted 20 G with **21,123,392 elements** on the same `25F84` / Darwin 25.5.0
build. Two things differ from the first three. Its panicked task is `zsh` (PID 45929, 0 pages,
1 thread) rather than `opencode.exe`, and its kext backtrace names only
`AppleMobileFileIntegrity(1.0.5)` with `CoreAnalyticsFamily`, `corecrypto`, `CoreTrust`, and
`AppleImage4` as dependencies - the strings `EndpointSecurity`, `security.quarantine`,
`filesystems.apfs`, and `IOStorageFamily` do not appear anywhere in the file. The largest-zones
table still shows `data.kalloc.1024` at 20 G with 0 B free against `APFS_4K_OBJS` at 342 M.
Compressor sat at 13% of its compressed-pages limit and 29% of its segments limit with 14 swapfiles
and OK swap, so this was again wired-zone exhaustion rather than RAM pressure.

That a one-thread `zsh` was the panicked task settles the point the next paragraph makes: the
panicked task is an accident of timing, and the varying kext backtrace means the trace names
whichever allocator happened to be on the stack, not the owner of the 21 million leaked objects.

The panicked task is the thread that requested the final allocation. It is not proof that the task
created or retained the preceding 20 million allocations. The APFS and EndpointSecurity frames
identify the kernel path active at exhaustion but do not identify which client or earlier operation
owns the leaked objects.

## Comparative Process Evidence

### Present In Both Panics

- OpenCode was active and was the panicked task in both reports.
- Little Snitch's daemon, network extension, and agent were active.
- Tailscale and its network extension were active.
- Apple XProtect and security services were active at low resident memory.
- APFS and EndpointSecurity were in the panic backtrace.

### Different Between Panics

- The August 3 report includes Docker Desktop, multiple Docker backends, and
  `com.apple.Virtualization.Virtualization` at approximately 8.6 GB resident memory.
- The August 4 report includes only the idle Docker `vmnetd` helper, about 4 MB; no Docker VM or
  Apple Virtualization process was active.
- The August 3 boot accumulated the leak over approximately 17 days; the August 4 boot reached
  exhaustion in less than 15 hours after heavy APFS copy-on-write and LanceDB churn.

Docker and Apple Virtualization are therefore possible pressure multipliers but are excluded as a
necessary condition for the panic.

## Extension And Security Inventory

`systemextensionsctl list` reported only two enabled third-party extensions:

| Extension | Type | Version | Relevant entitlement |
|---|---|---|---|
| Little Snitch | Network content filter and DNS proxy | 6.4.1 / 7212 | `com.apple.developer.networking.networkextension` |
| Tailscale | Packet tunnel | 1.102.1 | `com.apple.developer.networking.networkextension` |

Code-signing inspection found no `com.apple.developer.endpoint-security.client` entitlement on
either extension. The Little Snitch root daemon and Docker `vmnetd` helper showed no EndpointSecurity
entitlement. No non-Apple kernel extension was loaded. This substantially lowers, but does not reduce
to zero, the likelihood that a third-party EndpointSecurity client owns the leak.

Apple XProtect services were present in both reports. Their visible executables use private Apple
security entitlements but did not expose a public EndpointSecurity client entitlement. XProtect is
normal platform state and showed low process memory and CPU in both stackshots. It remains part of
the Apple security path, not a demonstrated cause.

## APFS And Filesystem Pressure Inventory

At investigation time the host had nine APFS containers and several mounted simulator disk images.
Relevant activity included:

- The internal APFS system/data container at 76% physical utilization.
- An external 4 TB APFS container mounted at `/Volumes/External`.
- Mounted Apple TV and iOS simulator APFS images, several at approximately 97% image utilization.
- Five `diskimagesiod` processes and active CoreSimulator services.
- An OWC Express 1M2 external storage device through a CalDigit TS5 Plus dock.
- gmax daemon, embed server, and worker filesystem activity.
- OpenCode and multiple development sessions generating FSEvents-visible changes.

The panic backtrace does not identify a specific volume. These items increase APFS and event volume
and should be minimized during post-update validation, but none is individually proven causal.

## LanceDB Soak Correlation

The isolated soak used a coherent 17 GB source snapshot and separate APFS copy-on-write stores.
Each runtime executed 100 maintenance iterations with 12 qualifying cycles above 50 fragments.

| Runtime | FTS optimize panics | Recovery failures | Correctness mismatches |
|---|---:|---:|---:|
| LanceDB 0.30 | 1 | 0 after FTS rebuild recovery | 0 |
| LanceDB 0.31 | 0 | 0 | 0 |

The 0.31 process completed before the host panic. Two conclusions were drawn at the time, and only
the second survived:

1. ~~LanceDB 0.31 behaved better than 0.30 for the observed user-space FTS merge failure.~~
   **Retracted 2026-08-05.** The control arm recorded exactly one panic, so 0-versus-1 could never
   separate a fix from chance. Live exposure then produced six panics on 0.31, and both releases
   were found to bundle the identical `lance-index 7.0.0` crate. The defect is version-invariant.
   See `docs/archived/lancedb-fts-panic-remediation.md` and
   [lance-format/lance#8310](https://github.com/lance-format/lance/issues/8310).
2. The host is not safe for deployment validation because the kernel crashed immediately after the
   qualifying workload. **This still holds.**

The retraction does not weaken the kernel findings below — it only removes LanceDB version choice
as a variable. The workload that preceded the panic was the same either way.

The kernel leak cannot be attributed solely to LanceDB because it was visible days earlier and a
matching panic occurred before the 0.31 soak. The soak remains a likely accelerator because it
performed sustained APFS clone writes, fragment creation, optimization, pruning, and file events.

## Root-Cause Assessment

| Candidate | Assessment | Evidence |
|---|---|---|
| macOS 26.5.2 APFS/EndpointSecurity defect | **Confirmed root cause** | Same OS, kernel, zone, and backtrace in all three panics; kernel-zone leak signature; no user-space program should be able to exhaust a kernel zone by writing files. |
| gmax LanceDB compaction write volume | **Confirmed primary trigger** | 100% of microstackshot samples in `lancedb...node -> write`; 549.76 GB dirtied in 12.3 h; 43 full compactions of a 16 GB table in two days; zone rate jumps ~450x during that window. |
| Unbounded `runMaintenance` compaction cadence | **Confirmed upstream of the above** | 5-minute tick re-optimizes whenever the write epoch moved; on a continuously-edited store that is always. No rate limit existed on either compaction caller. |
| `platform` GraphQL codegen | **Excluded on inspection** | Already `excluded` by the default ignore policy; 19 matching rows in the store, all from an unrelated test file. Its 10,399 log mentions are pre-filter watcher noise. |
| High-volume filesystem and FSEvents activity | Strong accelerator | OpenCode was at the final allocation path all three times; `bsdtar` under Codex dirtied 2.15 GB in the panic-3 burst window. |
| LanceDB 0.31 | Excluded | Live store was never upgraded to 0.31; panic 3 ran the shipped version. The issue is compaction frequency, not engine version. |
| Docker/Apple Virtualization | Secondary pressure source, not required | Active only in first panic and absent in second. |
| Little Snitch | Isolation candidate, low evidence | Active in both, but signed components are Network Extension clients without EndpointSecurity entitlement. |
| Tailscale | Isolation candidate, low evidence | Active in both, but packet-tunnel Network Extension only. |
| CoreSimulator and disk images | Possible APFS pressure multiplier | Multiple mounted APFS images and disk image services; no direct stack attribution. |
| External APFS storage/dock | Possible APFS pressure multiplier | Active external APFS volume; no volume identity in panic stack. |
| XProtect/securityd | Apple-path participant, unproven | Present in both as expected; low resource use and no client ownership evidence. |
| User RAM or swap exhaustion | Excluded | Compressor and swap reported OK; failure was kernel zone-map exhaustion. |
| Hardware memory fault | Low likelihood | Deterministic allocator-zone leak message and matching software stack; no hardware error signature. |

## Immediate Safety Decision

- Do not rerun the LanceDB soak on macOS 26.5.2.
- Do not deploy LanceDB 0.31 to the live shared store.
- Avoid bulk APFS clones, deletes, simulator installs, and unnecessary compaction before updating.
- Preserve both panic reports before system cleanup or diagnostic rotation.
- Reboot if `data.kalloc.1024` begins sustained rapid growth; killing user processes cannot reliably
  reclaim leaked kernel allocations.

## macOS 26.6 Update Runbook

### Pending Application Updates

Fresh Homebrew and Mac App Store metadata identified these additional updates:

| Software | Installed | Available | Priority |
|---|---:|---:|---|
| Parallels Desktop | 26.3.3 | 26.4.0 | High after macOS update; update before re-enabling VMs. |
| Microsoft Office apps | 16.107.1 | 16.111 | Medium; Microsoft AutoUpdate's CLI connection failed, so use its GUI. |
| Brave Browser | 1.90.121 (`148.1.90.121`) | 1.93.129 | Routine security update. |
| Microsoft Edge | 144.0.3719.115 | 151.0.4129.59 | Routine security update. |
| Arc | 1.126.0 | 1.158.1 | Routine security/stability update. |
| Eclipse Temurin | 26.0.1+8 | 26.0.2+10 | Routine JDK update. |
| Node.js | 26.5.1 | 26.6.0 | Defer until after host validation; run gmax gates after upgrading. |
| ggml | 0.18.0 | 0.18.1 | Low; unrelated to panic. |
| llama.cpp | 10240 | 10250 | Low; unrelated to panic; do not load a model during validation. |
| llmfit | 1.1.7 | 1.1.8 | Low; unrelated to panic. |
| SDL3 | 3.4.12 | 3.4.14 | Low; unrelated to panic. |
| whisper.cpp | 1.9.1 | 1.9.2 | Low; unrelated to panic. |

Mac App Store updates are available for Bitwarden 2026.7.0, Noir 2026.1.8, Screens 5.8.12,
Shapr3D 26.140, StopTheMadness Pro 27.1, Strongbox 1.65.0, Termius 9.42.2, and uBlock Origin
Lite 2026.729.1529.

Little Snitch 6.4.1, Tailscale 1.102.1, Docker Desktop 4.85.0, and Google Chrome
151.0.7922.72 match current Homebrew cask metadata. Adobe Creative Cloud 6.9.0.620 and its
applications must be checked through Creative Cloud because no reliable command-line update query
was available.

Do not batch all updates before the OS change. Install macOS 26.6 first, update Parallels before
using virtualization, then apply routine application updates after the initial kernel-zone baseline
is recorded. This preserves a useful boundary between the OS remediation and unrelated changes.

### Before Updating

1. Save and commit or otherwise preserve active work. The update requires a restart.
2. Create an external backup. No Time Machine destination is currently configured.
3. Preserve the two panic files and their SHA-256 checksums listed below.
4. Quit Docker Desktop, Parallels, Simulator, Xcode, and other VM/disk-image workloads.
5. Stop nonessential development sessions and allow filesystem activity to settle.
6. Keep the Mac connected to AC power. Current free space is sufficient for the 3.8 GB update.
7. Install macOS Tahoe 26.6 build `25G72` through Software Update.

### After Updating

1. Confirm `sw_vers` reports 26.6 / `25G72` and record the new Darwin kernel and APFS versions.
2. Confirm Tailscale and Little Snitch extensions remain enabled and current.
3. Run `zprint -t` and record the `data.kalloc.1024` live-element count as the new baseline.
4. Keep Docker, Parallels, and Simulator closed for the first normal-workload observation window.
5. Resume ordinary OpenCode and gmax activity, but do not run the heavy LanceDB soak.
6. Recheck the zone after one hour, at the end of the workday, and after 24 hours.
7. Treat monotonic growth into hundreds of MB or rapid acceleration as a failed OS remediation.
8. If stable, re-enable virtualization and simulator workloads one category at a time while
   continuing daily zone checks.

## Isolation Order If Growth Recurs On 26.6

Use normal work rather than the destructive soak. Change one category per observation window:

1. Close all simulator runtimes and unmount simulator disk images through Xcode tooling.
2. Keep Docker Desktop and Parallels fully stopped, including background VMs.
3. Disconnect nonessential external APFS storage after cleanly ejecting it.
4. Temporarily disable Little Snitch's network extension through System Settings.
5. Temporarily disconnect and disable Tailscale's network extension.
6. Compare OpenCode-heavy filesystem sessions with a low-change terminal/editor session.

Little Snitch and Tailscale are late in this order because entitlement inspection does not support
them as direct EndpointSecurity clients. OpenCode should not be called the root cause merely because
its thread requested the final allocation.

## Apple Escalation Package

If the zone grows abnormally or another panic occurs on 26.6, submit Feedback Assistant evidence
before rebooting when feasible:

- Both retained 26.5.2 panic reports.
- The new 26.6 panic report or sysdiagnose.
- `sw_vers`, kernel version, and APFS version.
- Timestamped `zprint -t` samples showing `data.kalloc.1024` growth.
- `systemextensionsctl list` output.
- Mounted APFS container and simulator state from `diskutil apfs list`.
- Whether Docker, Parallels, Simulator, Little Snitch, Tailscale, external APFS storage, OpenCode,
  and gmax were active during each sample.
- The observation that both 26.5.2 panics share the EndpointSecurity/APFS backtrace and that the
  second boot leaked from normal baseline to exhaustion in less than 15 hours.

Do not generate a sysdiagnose during obvious near-exhaustion if the added disk and event load risks
another immediate panic. Preserve a panic report after reboot instead.

## Retained Evidence

| File | Size | SHA-256 |
|---|---:|---|
| `/Library/Logs/DiagnosticReports/panic-full-2026-08-03-152634.0002.panic` | 2.6 MB | `5c01bb09b1781e63296f4883d27fc2ba4fe42ff5a76c0157b56d1a1ff1118101` |
| `/Library/Logs/DiagnosticReports/panic-full-2026-08-04-060621.0002.panic` | 3.3 MB | `fb0985580c351f59e2050044ac560ec0bfc5c9179f393995ecd0f5d1c924e03f` |
| `/Library/Logs/DiagnosticReports/panic-full-2026-08-17-145702.0002.panic` | 3.4 MB | `934e811d98b8a275666eee8ab0b7274d7ae240e55b63a603e34ef1daa556c664` |
| `/Library/Logs/DiagnosticReports/panic-full-2026-08-21-162430.0002.panic` | 2.9 MB | `27f5c827ecba753ec19183668969e7de5ca2da0e426ba116375dccd8998c8b38` |

The August 3 and August 4 panic files are **no longer present** on the host; only the August 17
report survives diagnostic rotation. Their hashes above are from the original investigation.

Attribution evidence for panic 3, all under `/Library/Logs/DiagnosticReports/`:

| File | What it establishes |
|---|---|
| `JetsamEvent-2026-08-17-003101.ips` | Zone at 1.37 GiB, pre-burst. |
| `JetsamEvent-2026-08-17-085010.ips` | Zone at 17.89 GiB, post-burst. |
| `node_2026-08-17-063018_*.diag` | gmax LanceDB writer, 549.76 GB dirtied, 100% of samples in `write`. |
| `bsdtar_2026-08-17-034406_*.diag` | Codex/ChatGPT tar extraction, 2.15 GB, same window. |

Evidence for panic 4 and the post-update window:

| File | What it establishes |
|---|---|
| `panic-full-2026-08-21-162430.0002.panic` | Fourth 20 G exhaustion on `25F84`; `zsh` as panicked task; no ES/APFS frames. |
| `~/.gmax/logs/daemon.log.prev` line 44361 | Guard's 4.31 GiB warning, 2026-08-21T06:55:35. |
| `~/.gmax/logs/daemon.log` lines 664-2056 | Two more warnings and **eight** 8 GiB stand-downs, 8.30 -> 15.14 GiB. |
| `JetsamEvent-2026-08-25-015144.ips` | First `25G83` jetsam: zone map 2.49 GiB, largest zone `APFS_4K_OBJS`. |
| `~/.gmax/logs/blocked-add.log` last line | First `git_worktree` refusal, 2026-08-25T13:27:23.223Z. |

Supporting Jetsam reports are under `/Library/Logs/DiagnosticReports/JetsamEvent-2026-*.ips`.
The isolated soak harness remains at `scripts/lancedb-fts-soak.mts`. The temporary snapshot, stores,
runtimes, and NDJSON files were automatically cleared by reboot.

## Open Questions

Updated 2026-08-25. Answers are from a single host over two days; see the caveats in
[Panic 4 And The 26.6.2 Update](#panic-4-and-the-2662-update-added-2026-08-25).

| Question | Status |
|---|---|
| Does macOS 26.6 change the code path that allocated the 1 KB objects? | **Answered, behaviorally.** On `25G83` (APFS 2811.160.7, xnu-12377.161.14~5), 182.4 GB of compaction rewrite over 27 h left `data.kalloc.1024` at ~269 MiB after 45 h. The same load shape on `25F84` produced multiple GiB/hour. Which change fixed it is still unknown - we observe the outcome, not the diff. |
| Which Apple EndpointSecurity client or event type retained the allocations? | **Still open, and now less likely to be answerable from these traces.** Panic 4's backtrace contains no `EndpointSecurity`, `quarantine`, `apfs`, or `IOStorageFamily` frame at all, so the kext list varies with whoever was on the stack and never identified the retaining client. |
| Does ordinary OpenCode/gmax filesystem activity grow the zone on 26.6? | **Answered: no, not measurably.** The Aug 24-25 window was well above ordinary activity and the zone's `cur size` never exceeded its high-water mark. |
| Do mounted simulator images or external APFS storage materially change the growth rate? | **Partly answered.** The Aug 24-25 window indexed four roots on an external APFS volume with no zone growth. Simulator images, Docker, and Parallels were not exercised and remain untested on `25G83`. |
| Can LanceDB 0.31 be validated safely on an unaffected host? | **Now plausible on this host,** which is no longer demonstrably unsafe. Not yet approved - the evidence is two days old and uncontrolled. |
| Why did the kernel-zone guard not prevent panic 4? | **Answered.** It fired, warned three times, and stopped the daemon eight times. `~/.gmax/autostart-disabled` was checked only by the session-start hook, so each stand-down was undone by a restart. Fixed in v0.26.19: the check now gates every implicit spawn path. |

## Decision

**Superseded 2026-08-25.** The original decision below was met: macOS 26.6.2 (`25G83`) is installed,
and the updated host has demonstrated bounded `data.kalloc.1024` usage - ~269 MiB after 45.5 h -
under a write load of the same shape as the one that produced panic 3. The host-safety block on
storage soaks and LanceDB work is lifted.

Three things carry forward:

1. **Keep sampling.** Two days is not a soak. Take the one-hour, end-of-day, and 24-hour readings
   against the 274,985-element privileged baseline of 2026-08-25 17:15, and re-sample after Docker,
   Parallels, and Simulator are re-enabled one category at a time.
2. **Close the auto-start hole before relying on the guard again.** A guard that stops the daemon
   while any `gmax add` can restart it bought nothing on Aug 21, and would buy nothing on a future
   kernel with the same defect. A fix is written and wired but not yet committed - see
   *Mitigations Shipped 2026-08-25*.
3. **Keep the compaction rate limit and backoff regardless of kernel version.** They are correct on
   their own terms - 182.4 GB of rewrite in 27 hours is wasteful even on a kernel that survives it.

> *Original decision, 2026-08-04:* Install macOS 26.6 before any further storage soak or LanceDB
> rollout. A stable user-space soak result does not override a host kernel crash. Resume Phase 4
> only after the updated host demonstrates bounded `data.kalloc.1024` usage under normal work and a
> separate low-risk validation strategy is approved.

## Mitigations Shipped 2026-08-17

| Change | Where | Effect |
|---|---|---|
| Compaction rate limit | `vector-db.ts` | 30-minute floor between opportunistic full-table compactions, shared by `runMaintenance` and `compactIfNeeded`. Forced callers bypass. Caps rewrite volume at ~2/hour regardless of churn. |
| Unproductive-compaction backoff | `vector-db.ts` | Interval doubles to a 6-hour ceiling when a pass reclaims nothing; resets on a productive pass. |
| Kernel-zone guard | `kernel-zone.ts`, `daemon.ts` | Daemon samples `data.kalloc.1024` every 5 minutes. Warns at 4 GiB (hourly, rate-limited), exits without relaunch at 8 GiB. An unreadable sample is treated as unknown, never as healthy. |
| Auto-start kill switch | `plugins/grepmax/hooks/start.js` | `~/.gmax/autostart-disabled` (or `GMAX_NO_AUTOSTART=1`) stops sessions from reviving the daemon. Currently active. |
| Empty index-dir sweep | `~/.gmax/lancedb` | 8,639 empty `_indices` husks removed. |

Test cover: `tests/vector-db-compaction-throttle.test.ts` (12 cases), `tests/kernel-zone.test.ts`
(10 cases). Full suite 1,099 passing; typecheck and Biome clean.

Not done, deliberately: the ~5 GB of stale FTS index copies needs a forced full optimize, which is
itself a whole-store rewrite. That is the exact operation under suspicion, so it waits for 26.6.2.
**Cancelled 2026-08-25** - `_indices` is down to 2.7 GB, reclaimed as a side effect of nine
compactions on the new kernel, so there is no longer a reclaim worth a forced pass.

## Mitigations Shipped 2026-08-25

| Change | Where | Effect |
|---|---|---|
| Worktree refusal | commit `4ef7c67`, v0.26.17/18 | `gmax add` refuses a git worktree root and records the attempt in `blocked-add.log` with `reason: "git_worktree"`. Prevents the specific 4-worktree indexing that drove the Aug 24-25 rewrite volume. |
| macOS 26.6.2 (`25G83`) | host | Darwin 25.6.0 / APFS 2811.160.7. The kernel-side half of the fix; see the bounded-usage evidence above. |

Still outstanding, and now the highest-value item: the auto-start kill switch is hook-only. A guard
stand-down is undone by the next `gmax add`, MCP session, or manual `gmax watch`. Panic 4 is the
cost of that gap - eight obeyed stand-downs and a 20 G exhaustion anyway.

**Fixed in v0.26.19.** The fix:
`src/lib/utils/autostart.ts` centralizes the kill-switch check (`GMAX_NO_AUTOSTART=1` first, then
`~/.gmax/autostart-disabled`) and it is wired into `daemon-client.ts`'s implicit spawn path,
`watcher-launcher.ts`, `gmax add`, and `gmax index`, with `plugins/grepmax/hooks/start.js` keeping a
plain-JS copy of the same semantics. Explicit `gmax watch --daemon` stays ungated by design.

## Version History

- **2026-08-25T17:30:00Z** Fourth panic (2026-08-21, still `25F84`, 20 G / 21,123,392 elements,
  `zsh` as panicked task, no EndpointSecurity or APFS frames in the backtrace). Established that the
  kernel-zone guard fired correctly - three warnings and eight stand-downs from 8.30 to 15.14 GiB -
  and was defeated because the auto-start kill switch is hook-only; the 8 GiB stand-down lines are in
  `daemon.log`, not in `daemon.log.prev` after the 4.31 GiB warning, which ends there only because
  the log rotated. Recorded the 2026-08-23 update to macOS 26.6.2 (`25G83`), Darwin 25.6.0,
  APFS 2811.160.7. Documented the accidental post-update exposure - daemon revived 2026-08-24T03:45
  despite the quarantine file, four external roots indexed, nine compactions freeing 182,382 MB - and
  the bounded result: ~269 MiB / 274,985 elements after 45.5 h, with `APFS_4K_OBJS` rather than
  `data.kalloc.1024` as the largest zone in the first `25G83` jetsam. Converted Open Questions to a
  status table, superseded the Decision, cancelled the deferred forced optimize (`_indices` now
  2.7 GB), and noted commit `4ef7c67`'s worktree refusal plus the reader-lease hang in
  `docs/known-limitations.md`.
- **2026-08-17T19:15:00Z** Third panic on the same unpatched build; the 26.6 update from the
  previous runbook was never installed. Added the jetsam growth curve, the microstackshot that
  attributes the burst to gmax's LanceDB writer (549.76 GB in 12.3 h), and the compaction
  write-amplification mechanism. Promoted gmax write volume from "possible accelerator" to
  confirmed trigger; excluded LanceDB 0.31. Corrected an intermediate revision of this report that
  blamed `platform`'s GraphQL codegen: those files were already excluded by the default ignore
  policy and write no vectors — the real driver is the unbounded 5-minute maintenance compaction.
  Shipped the rate limit, backoff, and kernel-zone guard. Daemon and auto-start disabled.
- **2026-08-05T22:40:00Z** Retracted the "0.31 behaved better" conclusion after live exposure
  falsified it; unblocked the 0.31 deployment note. Kernel findings unchanged.
- **2026-08-04T21:01:30Z** Incident report created from the two panic reports and jetsam history.

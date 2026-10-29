# P3 swap-guard investigation — October29,2026

Read-only operational investigation; deployment/core/plugin retries remain
unselected. No tests/builds/compilation/profiles/stress/runtime/MCP/search/model
calls, signals, service/config/kernel changes, swapoff/cache drops or remote
commands. Original failed and passing receipts were not rewritten.

## Conclusion

Both failures measured **P3 itself**, where the release controller and staging
ran locally. No separate control-host/remote-P3 baseline was combined. Current
hostname is `p3`, Linux `7.0.0-38-generic`, procfs plus cgroup2; PID1 is systemd.
Approximate boot time2026-10-23T07:30:09Z precedes both failures. Current self
PID/mount/UTS/cgroup namespace identities are retained privately; PID1 namespace
symlink comparison is permission-denied, not bypassed. The historical receipts
have no namespace/host fingerprint, so inode equality at event time cannot be
proven retrospectively. Source/execution history establish the local-P3 route.

There is real allocated swap, but **neither old failure proves owned-work swap
or disk write activity**. This limited current observation showed no increase
in the disk swap-output counter. Exact historical causation remains unknown.

## Exact guard meaning and historical timeline

Both retained controllers' `memory()` read their own absolute `/proc/meminfo`,
multiply Linux kB values by1024, and return `MemAvailable` plus
`SwapTotal-SwapFree`. Baseline, loop and final reads are in the same controller;
children only change affinity/nice/process group and never move the controller
into another namespace. Staging's child only extracts/copies into an owned local
prefix; no SSH/native reader or service operation is involved. Missing required
fields raise `KeyError`, not silent zero. No conversion/baseline-host mixup found.

- Compiler/runtime window:3.408306s, all commands exit0; final swap-allocation
  growth14,573,568B,30,335,418,368B available,381,321,216B sampled peak ownedRSS.
  [Original failed receipt](compile-prep-original-failed.json). Artifact mtimes
  approximately10:38:48.923–10:38:52.332UTC; these are file-time proxies, not
  recorded baseline/trigger timestamps.
- Fresh separately authorized pack:18.585845s,zero growth, guard passed;
  [receipt](fresh-pack-guard.json), unchanged compiler/runtime outputs reused.
- Staging:1.647504s, final allocation growth160,866,304B,35,792,224,256B available,
  224,145,408B sampled peak ownedRSS, owned cleanup complete.
  [Original failed receipt](staging-guard-failed.json). Log/receipt mtimes
  10:54:11.582–10:54:13.231UTC, again not exact sample timestamps.

The receipts do not retain absolute baseline/final swap values, per-sample
wallclock/counters, maximum swap-growth sample, owned `VmSwap`, cgroup attribution
or event-time PSI. `finalSwapGrowthBytes` is the final net difference clamped at0,
not peak swap or swap-I/O bytes. `peakSampledOwnedRssBytes` is independently sampled
owned-process-group RSS. The final guard can overwrite the earlier failure reason.
Consequently the final growth is not necessarily the initial trigger value.
The compiler receipt lists all4phases completed; its failure was only the final
host check, after command exit. Staging lacks a completed child exit record;
its final sample includes owned termination/cleanup time. No historical
live-process blame is recoverable from these records.

## Two bounded passive observations

Successful snapshots at11:24:41.863 and11:25:16.959UTC,35.096s apart; no workload
was launched. One preliminary PID1 namespace read was refused; it was corrected
by recording permission-denied, with no elevation/bypass. No smaps/page-table or
recursive cgroup scan; only `/proc/*/status` once, selected cgroup ancestors once,
and the second host counter read. Raw allowlisted local evidence:
`/home/reoiv/.local/state/gmax-swap-investigation/20261029/`.

| Item | Observation |
| --- | --- |
| Usable RAM |61.10GiB |
| MemAvailable |33.09→31.74GiB |
| MemFree |5.67→2.43GiB |
| Cached |24.67→26.59GiB |
| Allocated swap initially |12.811GiB of32GiB `/swap.img` swapfile |
| Net allocated swap change |−46,297,088B (−44.15MiB) |
| `pswpout` change |0pages; no swap-device page output counted |
| `pswpin` change |3,596pages (14,729,216B) |
| PSI memory |Initially avg10=0%; afterward some0.20%/full0.19%, avg60 some0.30%/full0.28% |
| OOM-kill counter change |0 |
| Swappiness |60; unchanged |
| zswap |Enabled,lzo,configured pool maximum20%; no zram device listed |

`MemAvailable` includes reclaimable memory; old allocated swap can coexist with
it. `SwapCached` was1.41GiB, already resident while retaining swap backing.
These definitions are in [kernel proc documentation](https://docs.kernel.org/filesystems/proc.html#meminfo).
Swappiness weights anonymous-versus-file reclaim, rather than setting a RAM-full
threshold; see [kernel VM controls](https://docs.kernel.org/admin-guide/sysctl/vm.html#swappiness).
This is a plausible general explanation for ample available RAM plus retained
swap, not proof of what caused the earlier spikes.

Zswap holds swapped pages compressed in RAM; user.slice held3,239,809,024B of
logical zswapped pages in1,241,910,167B compressed storage. Thus swap allocation
is not synonymous with bytes on disk. See [kernel zswap documentation](https://docs.kernel.org/admin-guide/mm/zswap.html).
Zero `pswpout` does NOT rule out compressed-swap activity: upstream Linux7.0
`swap_writeout()` can finish through `zswap_store()` before the disk PSWPOUT
counter path. [Official kernel source](https://github.com/torvalds/linux/blob/v7.0/mm/page_io.c).
No zswap-event delta was captured, so no claim that every kind of swap was idle.

## Current holders and cgroup limits

734process status files readable,0unreadable,0exits during that single walk;
namespace symlinks are a separately denied interface. Sum of per-process VmSwap
12,643,868,672B differs from host allocated13,755,789,312B by1,111,920,640B.
These counters are not an atomic/complete shared-memory accounting equality:
VmSwap excludes shmem swap, and swapcache/shared accounting differ. The gap is
retained, not assigned to an invented process. RSS sums also double-count shared
pages and are not unique physical memory. [Kernel process fields](https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories).

| Current holder | Swap evidence |
| --- | --- |
| Three largest `next-server` processes, UID1000/PIDs3011095,131482,741644 |4,490,301,440+1,144,700,928+580,464,640B =5.79GiB |
| Their session-236 group |6.85GiB sumVmSwap; cgroup swap.current6.94GiB |
| Gmax daemon |19,431,424B =18.53MiB VmSwap |
| One Gmax worker |24,948,736B =23.79MiB VmSwap |
| Gmax service cgroup, including cache/children |94,355,456B ≈89.98MiB swap.current |
| 51 Gmax MCP processes in T3-owned scope |961,880,064B ≈917.32MiB sumVmSwap; summedRSS2.99GiB, not deduplicated |

These are **current holders**, not historical causes. Multiple MCP instances
are permitted; this observation does not prove orphaning or a cleanup defect.
Gmax service memory.current was7.08GB, memory.high/max/swap.max allmax. All its
inspected ancestors were unconstrained. The agent aggregate had17.53GB current
versus59.16GB high/61.31GB max; its inspected high/max/oom events were0. The
selected Next/session and T3 service groups also had no binding high/max limits.
No inspected cgroup high/max enforcement currently explains swapping despite
freeable global memory. Historical limit settings were not retained.
The [cgroup contract](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)
distinguishes limits, swap accounting and reclaim; current counters are not an
event-time pressure history. Some direct reclaim occurred during the interval,
so “no pressure of any kind” would overstate the evidence.

## Recommendation and unchanged stop

Keep the configured zero-host-swap-allocation stop and all existing limits. It
correctly observes the literal host-wide policy, but is not an owned-process or
disk-I/O invariant. No arithmetic bug or retrospective attribution fix found.
Do not silently replace its metric or raise/disable it. A future guard change,
if selected, should retain host-wide stops and separately record initial/final
host/time/counters plus owned-process/cgroup swap attribution; none is implemented.

**One concrete first cleanup target:** have the owners of the three large Next.js
dev-server processes verify which are still needed and close unused servers
through their normal owning sessions. They hold5.79GiB of swap, substantially
more than the Gmax service. This is a bounded cleanup recommendation, not a claim
that those processes caused either failure, and no process was stopped here.
Do not swapoff, drop caches, tune swappiness or restart Gmax based on this capture.
If all servers are needed, their swap residency alone does not justify eviction;
there is no observed ongoing disk swap-out problem to “fix” by forcing pages in.

A later expressly selected operation could retain just before/after `pswpout`
and its owned cgroup `memory.swap.current`, with times, alongside the unchanged
host-wide guard. That would distinguish disk traffic/owned residency from other
activity; it does not authorize another attempt or monitoring loop now.

No deployment or guard window was reopened. Published110/last-deployed109 and
core8 activation pending remain unchanged. No retry/new query budget. Raw private
snapshots and this note suffice; no automated monitoring/profiling loop proposed.

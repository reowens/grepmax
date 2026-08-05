---
type: doc
status: active
created: 2026-08-04T20:50:29Z
updated: 2026-08-05T22:40:00Z
surfaces:
  - host
  - store
  - daemon
domain: macOS APFS and EndpointSecurity kernel-zone exhaustion incident
audience: internal
summary: Investigation and remediation record for recurring data.kalloc.1024 kernel panics on macOS 26.5.2.
related_plans:
  - archived/lancedb-fts-panic-remediation.md
related_docs:
  - docs/2026-08-04-performance-review.md
current_state: >
  Two panics on macOS 26.5.2 build 25F84 exhausted data.kalloc.1024 at 19-20 GB with
  matching APFS and EndpointSecurity backtraces. The leak predates the LanceDB soak and
  recurred without Docker virtualization. macOS 26.6 build 25G72 is available but not yet
  installed. No third-party EndpointSecurity or kernel extension was identified.
next_step: >
  Save work and create an external backup, then install macOS 26.6 and establish a fresh
  data.kalloc.1024 baseline. Avoid heavy APFS churn until normal-workload monitoring shows
  that the zone remains bounded. Escalate to Apple with both panic reports if growth recurs.
---

# macOS Kernel-Zone Panic Incident - 2026-08-04

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
| Internal APFS container | 994.7 GB total, 755.6 GB used, 239.1 GB unallocated |
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

The first failing boot lasted approximately 17 days. The second failing boot lasted only 14 hours
and 39 minutes. This variance is consistent with workload-dependent acceleration of a kernel leak.

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
| macOS 26.5.2 APFS/EndpointSecurity defect | Primary suspect | Same OS, kernel, APFS build, zone, and backtrace in both panics; kernel-zone leak signature. |
| High-volume filesystem and FSEvents activity | Strong trigger/accelerator | OpenCode was at the final allocation path twice; second panic followed heavy soak churn. |
| LanceDB 0.31 | Not established as root cause | Leak predates the soak and first panic predates the experiment; candidate process completed successfully. |
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

Supporting Jetsam reports are under `/Library/Logs/DiagnosticReports/JetsamEvent-2026-*.ips`.
The isolated soak harness remains at `scripts/lancedb-fts-soak.mts`. The temporary snapshot, stores,
runtimes, and NDJSON files were automatically cleared by reboot.

## Open Questions

- Does macOS 26.6 change the APFS or EndpointSecurity code path that allocated the 1 KB objects?
- Which Apple EndpointSecurity client or event type retained the allocations?
- Does ordinary OpenCode/gmax filesystem activity grow the zone on 26.6?
- Do mounted simulator images or external APFS storage materially change the growth rate?
- Can LanceDB 0.31 be validated safely on an unaffected host after the OS issue is cleared?

## Decision

Install macOS 26.6 before any further storage soak or LanceDB rollout. A stable user-space soak result
does not override a host kernel crash. Resume Phase 4 only after the updated host demonstrates bounded
`data.kalloc.1024` usage under normal work and a separate low-risk validation strategy is approved.

## Version History

- **2026-08-05T22:40:00Z** Retracted the "0.31 behaved better" conclusion after live exposure
  falsified it; unblocked the 0.31 deployment note. Kernel findings unchanged.
- **2026-08-04T21:01:30Z** Incident report created from the two panic reports and jetsam history.

# The swap guard measures the wrong proxy for owned-work spill

October29,2026; read-only follow-up to [the two passive snapshots](swap-investigation.md).
No new memory samples/process inventory, workload, tests/build/compile/native/
MCP/model/profile, service/config/kernel change, guard retry or deployment.
One bounded cgroup permission-metadata read supported the correction proposal;
no scope was created and nothing was written to cgroupfs. Original failed receipts
remain failed and unchanged. The prior Next-server inventory establishes holders,
not causes; stopping those servers is not the correction recommended here.

## Decisive result

**Yes: this is an unsuitable spill/pressure detector. No: the byte calculation
is not wrong.** It rejects any sampled increase in allocated swap slots anywhere
on P3, including allocations for unrelated work and slots not yet corresponding
to an evicted page or disk write. That is faithful to the selected literal
zero-host-used-swap rule, but it cannot establish that our224MiB staging task
spilled memory or endangered a host with35GB available.

No retained event-time evidence proves that either old stop was a false positive
for owned spill. The structural false-positive route is established from source;
which route caused14,573,568B/160,866,304B remains unknowable from those receipts.
A separate, certain reporting defect overwrites the original trigger with a final
post-cleanup failure and exposes a later delta as the reported amount.

Static counterexample, not executed: an unrelated process reserves one4KiB slot
while our payload has zero swapped pages; line37/62 still aborts. Conversely,
other slot frees can cancel new allocation between samples. So the metric has
both false-positive and false-negative routes for an owned-spill goal.

## Kernel trace: real allocation accounting, not an RSS estimate

Observed kernel:Ubuntu `7.0.0-38-generic`. The version-pinned upstream comparison
is Linux**v7.0**, not an unversioned latest branch. Installed matching header
`/usr/src/linux-headers-7.0.0-38/include/linux/swap.h:438–450` corroborates the
atomic counter. Full Ubuntu patched implementation was not available locally;
upstream source is not asserted byte-identical to that build.

- [`meminfo_proc_show`](https://github.com/torvalds/linux/blob/v7.0/fs/proc/meminfo.c#L32-L83)
  calls `si_swapinfo()` once; SwapTotal and SwapFree are emitted from the same
  stack result. Units are page-count→KiB; the controller's ×1024 is correct.
- [`si_swapinfo`/allocation/free](https://github.com/torvalds/linux/blob/v7.0/mm/swapfile.c#L3353-L3368)
  read a global atomic free-slot counter, adjusted by actual range allocation/free.
  This is not delayed folding of per-CPU RSS/vmstat estimates. Per-CPU cluster
  allocation exists, but is not evidence of fictitious statistic jumps. Different
  fields such as MemAvailable need not share the same instant.
- [`folio_alloc_swap`](https://github.com/torvalds/linux/blob/v7.0/mm/swapfile.c#L1384-L1436)
  allocates slots while the folio is still resident and adds it to swapcache;
  memcg charging may subsequently fail and undo that reservation. Cached slots
  can stay allocated after PTE references fall; freeing can be deferred until
  cache removal. Readahead/cache residency is not synonymous with fresh spill.
- [`swap_writeout`](https://github.com/torvalds/linux/blob/v7.0/mm/page_io.c#L226-L285)
  may finish via zero-page handling or zswap before disk PSWPOUT accounting.
  Thus SwapUsed growth can occur without increased disk-output counters, and
  unchanged resident data at an instant need not imply unchanged slot allocation.

These mechanisms establish possible distinctions, not the historical cause.
Do not subtract SwapCached, invent an accounting-error tolerance, or treat the
later zero-pswpout sample as proof of no earlier swapping. Net allocation can also
stay flat while allocation/free or disk output occurs, so this proxy can miss
activity as well as over-attribute it.

## Actual local control flow and the definite reporting bug

`/home/reoiv/.local/state/gmax-delivery/20261029-0.26.110/compile-prep-controller.py`:

- **8–10**: parse one `/proc/meminfo` read, strict required-field access; no silent
  missing→0, floats, alternate host or read-unit error.
- **17,29–39**: one fresh admission baseline spans all4local phases, waits and
  observer/host activity. Any sampled positive host delta aborts; it is not an
  owned-process/cgroup measurement or a reused previous-run baseline.
- **40–45**: retained receipt has all4phases complete/exit0, so this particular
  stop was detected only by the final check after commands exited.
- **53–56**: final read, `max(0, signed_delta)` output, then unconditional overwrite
  of `error`. A prior reason/trigger sample can be lost. Negative clamp affects
  reporting only; threshold comparison remains against the original baseline.

`/home/reoiv/.local/state/gmax-handover/20261029-0.26.110/stage.py`:
**41,59–64** use the same rule. **67–82** catch/clean up then overwrite the reason
and retain only a final delta. Missing child-exit record and up to0.5s termination
wait mean160,866,304B need not be the first trigger value. That check also includes
unowned host activity during cleanup. No exact before/trigger values or counter
samples were retained; file mtimes are only approximate window boundaries.

## Four different invariants

| Intended invariant | Suitable measurement | What current SwapUsed guard establishes |
| --- | --- | --- |
| Our job must not spill | An isolated owned cgroup's swap current/peak/max; process VmSwap is partial | No ownership attribution |
| No new swap-device writes | pswpout delta, interpreted separately from zswap | Not disk traffic |
| Host stays safe | Existing8GiB available floor, critical/quarantine/OOM stops; PSI describes stalls | Not pressure severity or causality |
| Host allocated swap never rises | SwapTotal−SwapFree against admission baseline | Exactly this sampled rule |

Durable [AGENTS completion policy](../../../../AGENTS.md#complete-the-approved-outcome-without-repeated-stops)
says **“Preserve host/process limits”**; [CLAUDE's contract](../../../../CLAUDE.md#completion-and-release-contract)
retains the same boundaries. Neither sentence defines all host swap movement as
owned spill. The [owning plan](../../gmax-delivery.md#cpu-attribution-proposal--deferredunselected)'s
retained window step4 explicitly selects **“zero used-swap growth”** from the
host admission baseline, and current delivery instructions preserved that rule.
Reusing a profile's literal global counter for operational staging is the
over-broad mapping identified here; AGENTS itself does not require that proxy. The controller faithfully inherited that
literal selection; it must not be silently waived on this read-only request.
These are operational controllers, not proof of a product runtime-guard defect.

## Narrow correction choices — PROPOSED ONLY

1. **Logging-only repair:** retain the first trigger, raw baseline, signed delta,
   trigger time and independent final sample; don't overwrite the first error.
   Compatible with the current rule, but still blocks on unrelated slot growth.
2. **Only process-group VmSwap:** narrower attribution, including anonymous data
   in zswap, but misses swapped shared memory and short-lived between-sample
   events. Existing shared agent cgroup also includes unrelated clients. Neither
   RSS-only nor disk-pswpout-only replacement is adequate. Not recommended alone.
3. **Recommended: job-specific zero swap plus existing host safety.** Run just the
   selected payload/children in a fresh user-owned cgroup, set its swap.max=0,
   observe current/peak/events and retain host diagnostics independently. This
   prevents job swap including zswap rather than permitting a larger allowance.
   Keep all CPU/nice/deadline/RSS/available-memory/containment/cleanup limits.

[Kernel cgroup documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)
distinguishes swap.current/peak/max from compressed backend storage; swap.max=0
blocks anonymous swap including zswap, unlike zswap.writeback=0. Prior evidence
proves cgroup2, readable memory interfaces and that the existing agent scope is
shared. The single permission-metadata check found its existing parent slice
UID1000/writable with memory+pids delegated. Thus an owned sibling transient
scope under that same parent is a grounded route, not a new supervisor service.
No safe scope creation was exercised; fail closed before payload start if it
cannot be created/read/enforced. Never set zero on the existing shared scope or
Gmax service, move peer clients or alter ancestor limits. Other OS paths are
outside this P3-only proposal; no silent less-safe fallback.

## Finite implementation scope if selected

1. **Contract:** replace the selected operational whole-host-allocation-zero
   predicate with **zero owned-job swap**, while retaining the8GiB host floor,
   twoCPUs/nice10,2GiB sampled ownedRSS,180s, containment and owned cleanup. Make
   clear this changes policy scope; it is not a mere parser fix or today's waiver.
2. **Two controllers only:** use existing user-systemd/delegation support for one
   empty job scope under the existing agent parent, enter it before payload exec,
   and enforce swap.max=0. Require readable current/peak/events, retain zswap
   counters and verify ownership for cleanup. No global agent/service settings.
3. **Host protection:** retain the available-memory/critical/latch stops and add
   fail-closed OOM-event detection; record PSI and disk pswpout separately. PSI is
   meaningful stall information, not a value to subtract from swap; no arbitrary
   new PSI percentage or broad swap tolerance is selected. Host SwapUsed stays
   diagnostic, not the owned-spill decision. [PSI meaning](https://docs.kernel.org/accounting/psi.html).
4. **Receipts:** preserve first failure and its exact trigger snapshot, with raw
   initial/trigger/final values and signed delta. Keep cleanup samples/failures
   separate. Lost essential metrics stop admission/execution; don't reinterpret
   old failed receipts as passes.
5. **Delivery boundary:** static source/diff integration and explicit user-selected
   ordinary guarded continuation only. No new unit/benchmark/review gate follows
   from this proposal, no fresh guard window is authorized now, and no new Gmax
   version/republish is necessary just to correct these operational controllers.

No source or durable contract was changed. Implementation of this scoped policy
change and a new operational attempt require selection; this turn authorizes
neither. Published110/P3last109/plugin/core8 pending remain unchanged. Preserve
both failures and unrelated pending hook/dependency/private/index/ITA work.

# Process-metric guard repair: source complete, unexecuted

October 29, 2026. User selected the missing-process-metric repair separately
from the Platform compiler-cap repair. This batch changes only the canonical
Gmax operational guard and its documentation; it does not run the guard or
retry WOL, perform hardware readback, save a connection profile, change power
settings or run tests, syntax/type compilation, builds, models or probes.

## Incident evidence and limits

Retained private evidence, unchanged:

- `/home/reoiv/.local/state/gmax-delivery/20261029-0.26.110/isolated-guard/power-saver-network-1793282098054-nm-wol-enable-guard.json`
  records revision3, operation `networkmanager-magic-wake-only`, commandStarted,
  firstFailure `"'VmRSS'"` at `2026-10-29T14:00:03.735138+00:00`, sample null,
  no cleanup errors, cohort empty/removed and zero owned-job swap.
- The companion `power-saver-network-1793282098054-nm-wol-enable.json` records
  NetworkManager Reapply accepted with requested magic-wake flag64. Execution
  stopped before runtime NIC verification or profile persistence; the receipt
  does not prove WOL enabled or saved. The earlier sudo refusal does not negate
  the recorded NetworkManager permission or successful Reapply return.

No event-time process identity/state/metric breakdown was captured, so an exit
race is a possible source route, not the proven cause of that historical failure.
The surviving invocation context does not identify the exact helper path. The
receipt is consistent with the canonical revision3 but cannot distinguish an
owned copy. No operational copy has been identified or guessed; only the known
canonical helper is repaired. Historical revision1/revision2 source snapshots
and all original receipts remain untouched. Future authorized operations should
use the canonical source path explicitly, rather than assuming an old copy was
updated. This note grants no such operation or retry.

Power-saver's last supplied verified observations were 13:54:58 and13:58:34 UTC,
all24 EPP values `power`, with Ethernet up/carrier1 and unchanged route. This
repair neither rechecks nor changes those settings. WOL remains **unverified and
not recorded as persisted**; there is no automatic WOL continuation here.

## Implemented boundary

`scripts/guard-local-operation.py` revision4 changes `status`, `sample` and
structured first-failure propagation:

- Open `/proc/<pid>` once as a directory descriptor; read stat/status/cgroup
  relative to that pinned directory. Bracket the status read with the PID's
  stat start time, so numeric PID reuse cannot redirect later reads to another
  process. Check live owned membership both before and after the status read.
- A confirmed Z/X/x task with no remaining thread-group members contributes
  no live RSS and increments `jobNonLiveProcessCount`. A dead leader with
  remaining threads fails closed, rather than zeroing a potentially live group.
- ENOENT/ESRCH contributes no live metrics only after a fresh owned-membership
  read confirms the numeric PID is absent. A still-listed/invisible PID is an
  explicit process-metric failure; this avoids treating hidden proc visibility
  or rapid in-group PID reuse as zero RSS. Supervisor absence always fails.
- A live missing VmRSS/VmSwap/State, non-integer/negative/wrong-unit value,
  permission/decoding/stat error, changed start time or mismatched membership
  remains a failure. No `.get(...,0)`, permission skip, catch-all skip, tolerance
  or lower threshold is introduced.
- `firstFailure.processMetric` carries PID, field and reason. The first failure
  remains immutable; the incomplete trigger sample remains null and is not
  replaced with the last good observation or successful cleanup sample.
  Cleanup errors and final samples retain their separate existing locations.

The new file-descriptor lifetime is local to one sample, closed in `finally`.
No task is launched, signalled or moved by the sampler itself. Existing owned
cleanup still uses its pidfd/cgroup ownership checks and whole-cohort cleanup.
No shared provider/service cgroup or controller setting is changed.

## Bounds and validation

Unchanged: fresh pre-exec `memory.swap.max=0`, two CPU affinity, nice>=10,
aggregate owned RSS<2GiB, 180-second deadline, min8GiB available memory,
job swap/current/peak/zswap and supervisor-swap checks, containment/quarantine,
OOM safeguards, bounded owned cleanup and empty-cgroup removal. Host swap
allocation remains diagnostic. The helper still refuses unavailable essential
visibility/enforcement; this is a process-lifecycle accounting repair, not a
memory-policy relaxation.

Validation is **source/control-flow and scoped whitespace/diff inspection only**.
No guard invocation, synthetic failure, fixture/test invocation, Python syntax
compile, TypeScript compile, build, live query, native operation, service action
or WOL retry was performed. There is no runtime validation claim for revision4.
The Platform compiler-cap owner has separate source/records; no Platform file is
included in this Gmax commit. Published/deployed110 and remote embedding's
planning-only state remain unchanged; no release or push is selected.

## Recenter follow-up, retained evidence only

Guard source repair is local commit `afb8dda`. Platform's separate compiler
containment repair is local commit `4434ed5aa99e1eef8c365cf80432de7358c6e5c2`;
its owning source-only record (private record)
reports no runtime qualification. The [delivery recenter](../../../gmax-delivery.md#recenter-quiet-p3-finish-wol-closure-before-optional-offload)
keeps WOL readback/persistence as the smallest proposed operational closure,
not an action performed or authorized by this documentation update. Both
historical failures and the unproven invocation path/exit-race cause above stay
unchanged. No power/network/guard operation or test was run for this follow-up.

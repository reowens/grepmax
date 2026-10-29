# P3 bounded FTS catch-up

This is the repeatable procedure for the existing released FTS updater. An
approved catch-up covers the admitted batches in one bounded owner window.
**Two batches are normal. Do not stop, call the first batch a failure, or ask
again when its receipt is completed and `remainingRows` is positive.**

## Completion and batch limits

Each call selects a prefix of whole pending fragments under both limits:

- 100,000 physical rows, including deleted rows.
- 64 MiB (67,108,864 bytes) of live UTF-8 content.

The first batch can stop below the row cap because the next whole fragment
would exceed the content cap. Read its `remainingRows`, inspect the fresh head,
and run the next admitted batch under the same owner. Do not raise caps or
switch to full-table optimization. The selected owner permits at most eight
freshly admitted calls in its non-resetting 110-second deadline, with the
120-second parent, two-CPU and 2 GiB process-group RSS guards unchanged.

Catch-up is complete when the **exclusive after snapshot reports zero unindexed
rows and the durable receipt is completed**. Normal indexing can append a new
tail after service restart. That does not invalidate the completed snapshot or
authorize an endless loop chasing a moving head.

## Operating sequence

1. Reuse the released helper/API and the existing small-model service. Do not
   rebuild native artifacts, load a model, rerun fixtures or add an acceptance
   review. Existing catch-up authorization remains valid across its batches.
2. Take host admission immediately before the FTS owner window. Do not reuse a
   historical profile's swap baseline as if it were a fresh maintenance sample.
   Preserve the 8 GiB available-memory /512 MiB swap-growth limits. After a
   pre-write host refusal, preserve that receipt, restore service, wait for the
   established 30-second stability window and continue under the same caps.
   This is resource readmission, not a new user-approval gate.
3. Create only an owned autostart marker, stop the existing service normally,
   confirm its predecessor exited, and acquire the exclusive StoreLease. Remove
   only the owned marker after the exclusive-ready handshake; preserve external
   safety/quarantine markers.
4. Read current metadata and state. Use `runFtsRefresh(...check:true...)` for the
   fresh head, then `runFtsRefresh(...run:true...)` with that expected version.
   The released helper enforces physical/content bounds, physical tokenizer
   metadata, immutable payload/index preservation and final lease ownership.
5. After each completed batch, read fresh metadata and durable state. Preserve
   base rows/other indexes, verify the returned head/remaining count, and continue
   if rows remain and the selected owner budget permits it. Do not release the
   owner or ask the user between normally completed batches.
6. Close all owned helpers/leases before restoring the same service. Confirm its
   version, ready/open admission, unchanged CPU/model/config/store controls, and
   record the final exclusive snapshot and all batch receipts.

If an interrupted **write** leaves an uncertain receipt, inspect that actual
attempt/head before another write and acknowledge only that verified attempt
through the released API. Never copy a hardcoded attempt ID from an old run.
A refusal before write admission is not an uncertain committed update. If state
cannot be established or a real guard remains active, report that exact blocker
and continue other approved work; do not manufacture more test/approval rounds.

## Last completed run: October 28, 2026 UTC

The current approved run completed **two batches**, not two failed attempts:

| Head | Physical rows | Live rows indexed | Live bytes | Rows remaining |
| --- | ---: | ---: | ---: | ---: |
| 9801 →9802 | 42,801 | 31,714 | 66,978,155 | 1,983 |
| 9802 →9803 | 2,281 | 1,983 | 3,175,531 | 0 |

The first call was constrained by the **64 MiB content limit**, not the
100,000-row limit. Snapshot **9803** has all **513,482** live rows indexed.
The owner finished in **6.71 seconds**, with zero sampled swap growth and all
owned processes closed. The same0.26.104 service resumed with its original
limits/configuration. No compaction or pruning ran.

An earlier launch was refused by host-wide swap growth **before write
admission**. It performed no FTS batch. The fresh admitted window above completed
normally. The search-profile arms separately hit their service RSS-growth guard;
**those are partial measurements, not FTS failures**. Keep the maintenance and
profiling outcomes separate in all summaries.

Current source/API driver and receipts (provenance, not a command to rerun blindly):
`/home/reoiv/.local/state/gmax-fts-cpu/20261028T233851Z/maintenance-admitted/`.
Use a fresh state directory and current installed-version admission for a later
selected run. Do not reuse old inspection IDs or create another package release
merely to run this existing updater.

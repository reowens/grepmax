---
type: plan
status: active
created: 2026-11-10T05:11:53Z
updated: 2026-11-10T05:11:53Z
surfaces:
  - daemon
  - watcher
modules:
  - src/lib/index/watcher.ts
  - src/lib/index/watcher-ignore.ts
  - src/lib/index/watcher-errors.ts
  - src/lib/index/watcher-recovery.ts
  - src/lib/index/watcher-batch.ts
  - src/lib/daemon/watcher-manager.ts
  - src/lib/utils/watcher-launcher.ts
  - src/commands/watch.ts
domain: Linux watcher correctness, one ignore source and one watcher implementation
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
  - docs/plans/gmax-delivery.md
  - docs/plans/gmax-catchup-throughput.md
related_docs:
current_state: "The P3 runs gmax 0.26.113 under gmax.service. Its journal since 2026-11-09 16:31 PST shows 0 poll-mode falls and 0 re-watch loops, but folders created after the subscribe get no watch (2 folders, 16 files missing from the index), Linux inotify overflow is dropped without a signal, and the subscription keeps its own ignore list (33,091 watches, 356 of them in gitignored folders)."
next_step: "Phase 1: merge the daemon and standalone watchers into 1 module, removing dead code from watcher-manager.ts first."
---

# Gmax watcher correctness

## Problem

Since 2026-09-01 gmax has 30 commits about its watcher. They are 27 distinct changes (3 landed twice) and fall into 3 structural roots plus 1 unrelated group. None of them fixes the ignore list or a Linux-only failure. Evidence for every claim below is in [findings-20261109.md](assets/gmax-watcher-correctness/findings-20261109.md).

1. **The subscription has its own ignore list.** `IGNORED_DIR_NAMES` (`src/lib/index/watcher.ts:48-73`) plus the root `.gmaxignore` decide what Parcel subscribes to. No `.gitignore` reaches it, and it has drifted from the indexer's `ProjectFilePolicy` (`.turbo` only in the watcher's list, `.claude` and `fixtures` only in the indexer's). Once events arrive, both use `ProjectFilePolicy`.
2. **Every detach and re-attach costs a 33 s crawl** of the whole platform tree, which cannot be cancelled. 12 of the 27 changes deal with that cost.
3. **Recovery is built for macOS FSEvents.** `isFSEventsGap` (`src/lib/index/watcher-errors.ts:3-11`) matches FSEvents messages only. On Linux, Parcel's inotify backend fails in 3 ways gmax neither detects nor repairs:
   - a folder that vanishes during the startup crawl (`inotify_add_watch ... No such file or directory`) drops the watcher into at least 20 minutes of polling (24 times before 0.26.113: 15 in gitignored trees, 9 in `docs/plans/assets`);
   - a folder created after the subscribe gets no watch, so files inside it are never indexed until the next full catch-up, while `gmax status` reports the watcher native and healthy (`src/lib/daemon/watcher-manager.ts:140-157`);
   - `IN_Q_OVERFLOW` is dropped silently, so a lost burst never triggers the gap catch-up.
4. **2 watcher implementations have diverged.** The daemon re-subscribes on every policy event without comparing ignore identity (`watcher-manager.ts:394-410`); the standalone watcher compares first (`watcher.ts:126-131`) and has no poll-mode fallback (`watcher.ts:325`).

CPU is not the issue: the watcher thread used about 0.9% of a core on 0.26.113.

## Agreed scope

- `docs/plans/assets` in the platform repo stays searchable and watched (agreed 2026-11-09). It is 29,130 of the 33,091 watches and most of the 33 s crawl; phases 2 and 3 make that crawl rare instead of removing the folder.
- The fixes stay inside gmax and Parcel's options, with no watcher backend migration (`gmax-delivery.md` § Work outside the execution queue, "Watcher event-drop cause").

## Phase 1: 1 watcher implementation

- [ ] Remove dead code from `watcher-manager.ts` (1,176 lines), then move subscribe, recover and reconcile into 1 module that both `startWatcher` and `WatcherManager` use.
- [ ] The daemon skips a re-subscribe when the ignore identity is unchanged, as the standalone watcher does.
- [ ] Tests cover both callers through the shared module.

## Phase 2: transient subscribe failures are retried

- [ ] `ENOENT` or `ENOTDIR` from the crawl or `inotify_add_watch`, on a path inside the root, is retried 2 to 3 times with seconds of backoff before poll mode, and the path is logged.
- [ ] On Linux, poll mode probes back to native on the first 5-minute poll rather than at 15 minutes.
- [ ] Tests use a fake subscribe that fails once.

## Phase 3: 1 ignore source for the subscription

- [ ] The Parcel ignore set is built from `ProjectFilePolicy`'s sources: default directory names plus root and nested `.gitignore` and `.gmaxignore` directory rules with their scope prefix, keeping the rule that skips negations and unsafe syntax. `IGNORED_DIR_NAMES` is deleted; the 8-literal cap stays macOS-only.
- [ ] A `.gitignore` or `.gmaxignore` written inside an excluded folder (for example `.ruff_cache`, `tmp/`) no longer forces a re-subscribe and catch-up.
- [ ] A guard test asserts every indexer directory exclusion is also a subscription exclusion.

## Phase 4: new folders and overflow on Linux

- [ ] A create event for a folder runs a scoped walk of it through `ProjectFilePolicy`, so files already inside are indexed.
- [ ] When that walk finds a subfolder, 1 debounced re-subscribe runs (20 non-ignored folders were created in the 4 h after one subscribe; 2 missed a watch). Patching Parcel's inotify backend instead is weighed here and chosen only if the debounced re-subscribe measures too costly.
- [ ] Overflow reaches the existing gap catch-up.
- [ ] `gmax status` shows a watcher that is missing coverage as degraded, not native.

## Phase 5: release and live check

- [ ] Release through `release.yml` and install on the P3 and the Pro (`scripts/postrelease.sh --install`).
- [ ] On the P3: the 2 unwatched folders' files are searchable, a new `mkdir -p` folder's files are indexed within the quiet window, gitignored folders are no longer watched, and the journal shows no poll-mode fall for 24 hours.

## Execution

Phases 1 to 4 edit the same files, so they run 1 at a time: 1 agent per phase, 4 in all, each checked by the main session against its phase before the next starts. Phase 5 runs in the main session. The live store's second regrowth record (`gmax-catchup-throughput.md` step 7) runs to 2026-11-11 16:00 UTC; phase 5 checks that step before it restarts the daemon.

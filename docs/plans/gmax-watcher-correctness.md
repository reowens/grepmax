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
  - docs/plans/gmax-archived-doc-ranking.md
related_docs:
current_state: "The P3 runs gmax 0.26.113 under gmax.service. Its journal since 2026-11-09 16:31 PST shows 0 poll-mode falls and 0 re-watch loops, but folders created after the subscribe get no watch (2 folders, 16 files missing from the index), Linux inotify overflow is dropped without a signal, and the subscription keeps its own ignore list (33,091 watches, 356 of them in gitignored folders)."
next_step: "Phase 5: after the regrowth record ends 2026-11-11 16:00 UTC, release, install on the P3 and the Pro, and run the live checks."
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

- [x] Remove dead code from `watcher-manager.ts`, then move subscribe, recover and reconcile into 1 module that both `startWatcher` and `WatcherManager` use. `src/lib/index/watcher-core.ts` holds `WatcherSubscription` (`update`, `settled`, `retire`, `detach`, `failed`), `reconcileProject` and the ignore globs; about 10 lines were dead (the unread `subscriptions` option in `daemon.ts`), and `watcher-manager.ts` is 1,111 lines.
- [x] The daemon skips a re-subscribe when the ignore identity is unchanged, as the standalone watcher does.
- [x] Tests cover both callers through the shared module: `tests/watcher-core.test.ts` (new) and `tests/watcher-manager.test.ts`. `pnpm typecheck` and `tsc -p tsconfig.tests.json` are clean; `vitest run` over the 4 touched watcher test files passed 49 of 49.
- The standalone watcher now ignores a failed unsubscribe of its old stream, as the daemon did. It still has no poll-mode fallback (a startup failure rejects at `watcher.ts:207`).
- Not run in this phase: `standalone-watcher-health`, `daemon-catchup-priority`, `native-watcher-exclusions`, `watcher-ignore` and `scripts/test-watcher-consumer.cjs`; phase 5's release check runs them.
- For the next phases: the subscribe retry goes in `WatcherSubscription.updateNow`, overflow in `watcher-core.ts`'s gap routing, and a subscription attached on the fallback globs re-subscribes on every policy event until phase 3 gives it 1 ignore source.

## Phase 2: transient subscribe failures are retried

- [x] `ENOENT` or `ENOTDIR` from the crawl or `inotify_add_watch`, on a path inside the root, is retried 3 times at 2, 4 and 8 s before poll mode, and the path is logged. `vanishedSubscribePath` (`src/lib/index/watcher-errors.ts:38`) decides it; the retry is in `WatcherSubscription.subscribe` (`src/lib/index/watcher-core.ts:166`), so both callers get it, and `retire()` wakes the backoff. A path outside the root, the root itself and other errors fail at once as before. A persistent failure reaches poll mode about 4 crawls plus 14 s later, roughly 2.5 minutes on a 33 s tree.
- [x] On Linux, poll mode probes back to native on the first 5-minute poll (`watcher-manager.ts:500`, `probePollModeRecovery` at `:624`, guarded so 2 probes never overlap); the 15-minute interval stays for every platform.
- [x] Tests use a fake subscribe: fails once then attaches, fails every time, rejects at once, retire wakes the backoff, startup reaches polling after 4 subscribes, and the 5-minute Linux probe. `vitest run tests/watcher-core.test.ts tests/watcher-manager.test.ts`: 51 of 51 on the second run (the first failed 1 test-only boundary check under fake timers); `pnpm typecheck` and the tests tsconfig clean.
- Parcel's crawl error carries no path, so its log line reads "(not reported)". Log lines still say "FSEvents" on Linux.

## Phase 3: 1 ignore source for the subscription

- [x] The Parcel ignore set is built from `ProjectFilePolicy`'s sources by `readNativeWatcherIgnores` (`src/lib/index/watcher-ignore.ts:85`): the default patterns, then every traversed folder's `.gitignore` and `.gmaxignore` rules scoped to that folder through `walkDirectories`. A rule file holding a negation still yields no globs; the folders it excludes become literal paths instead. `IGNORED_DIR_NAMES` and `readProjectWatcherIgnores` are deleted. The 8-literal cap applies on macOS only; on Linux every folder a policy file excludes is a literal.
- [x] A `.gitignore` or `.gmaxignore` written inside an excluded folder no longer forces a re-subscribe: the batch processor drops a policy event whose folder the loaded policy excludes (`src/lib/index/batch-processor.ts:199`).
- [x] `tests/watcher-exclusion-parity.test.ts` asserts every directory the indexer walk excludes is also excluded from the subscription. `.turbo` moved into the default patterns, so the indexer skips it too.
- Each update now walks the whole tree, about 5.8 s on the platform repo against about 250 ms before, and a subscribe walks it twice (read, then verify). Updates run only at startup, on recovery and on a policy edit outside an excluded folder. On Linux, a gitignored folder that appeared since the last subscribe changes the identity, so a policy edit that leaves the rules unchanged can still re-subscribe once.
- Checked: `pnpm typecheck` clean; `vitest run` on the 5 changed test files 156 of 156 on the second run. `tests/standalone-watcher-health.test.ts` was not run; Phase 4's run includes it.

## Phase 4: new folders and overflow on Linux

- [x] A create or update event for a folder runs a scoped walk of it through `ProjectFilePolicy` and passes its files on as create events (`coverNewFolders`, `src/lib/index/watcher-core.ts:201`). Linux only; FSEvents already reports them.
- [x] When that walk finds a subfolder that is not ignored, 1 re-subscribe runs 5 minutes after the first request (`requestResubscribe`, `watcher-core.ts:186`; `NEW_FOLDER_RESUBSCRIBE_DELAY_MS` at `:36`), forced past the unchanged-identity skip and followed by the owner's catch-up. Parcel's inotify backend already watches a new folder itself (`InotifyBackend.cc` `handleSubscription` calls `watchDir`); only subfolders already inside it are missed. Patching Parcel was not done: the backend ships as a prebuilt binary, so a patch means a fork and a native build per platform.
- [x] Overflow reaches the gap catch-up through an inferred signal. Parcel drops `IN_Q_OVERFLOW` with no error and no log (`node_modules/@parcel/watcher/src/linux/InotifyBackend.cc:120-123`), so a Linux delivery of 4,096 or more events raises a `CoverageGap` (`src/lib/index/watcher-errors.ts:17`, `isEventGap` `:19`) on the normal gap path. Parcel counts 1 event per path, so the threshold can miss a real overflow or fire on a large checkout.
- [x] `gmax status` shows `watcherMode: "degraded"` with a `watcherReason` while a new-folder re-subscribe is pending, and after an inferred gap until a complete catch-up that started after it (`watcher-manager.ts:134-147`, `src/lib/index/watcher.ts:229-247`); the footer prints "watcher degraded: <reason>". While degraded, document search reports coverage partial.
- A failed forced re-subscribe in the standalone watcher leaves it detached with nothing retrying, as a failed policy-edit re-subscribe already does.
- Checked: `pnpm typecheck` and the tests tsconfig clean; biome clean on the 12 files; `vitest run` on `watcher-core`, `watcher-manager`, `standalone-watcher-health`, `watcher-exclusion-parity`, `project-batch-processor` and `index-state-footer` 154 of 154. 3 small fixes after that run (gap cleared before the store write, timer gives up when detached, update events checked) are covered by typecheck only. `mcp-read-verbs`, `status-command` and `daemon-index-health` were not run; Phase 5's live check covers the wiring.

## Phase 5: release and live check

- [ ] Release through `release.yml` and install on the P3 and the Pro (`scripts/postrelease.sh --install`).
- [ ] On the P3: the 2 unwatched folders' files are searchable, a new `mkdir -p` folder's files are indexed within the quiet window, gitignored folders are no longer watched, and the journal shows no poll-mode fall for 24 hours.

## Execution

Phases 1 to 4 edit the same files, so they run 1 at a time: 1 agent per phase, 4 in all, each checked by the main session against its phase before the next starts. Phase 5 runs in the main session. The live store's second regrowth record (`gmax-catchup-throughput.md` step 7) runs to 2026-11-11 16:00 UTC; phase 5 checks that step before it restarts the daemon.

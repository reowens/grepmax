# Known Limitations

Last updated 2026-05-21.

## LanceDB manifest references a missing fragment file

Verified 2026-05-07.

After an interrupted compaction, the LanceDB manifest can reference a fragment file (`<hash>.lance`) that no longer exists on disk. Symptoms in `~/.gmax/logs/daemon.log`:

```
[watch:<project>] DATA CORRUPTION: LanceDB manifest references a missing fragment.
Backing off this project's batch processor for 30 min. To repair, run: gmax index --reset
```

The daemon's batch processor (since v0.16.0, commit `fd05089`) detects this via `isLanceCorruptionError()` and backs off for 30 minutes per affected project, logging once per hour. Read-path queries (search/peek/extract/etc.) continue to work — only the write path (incremental reindex) is paused.

**Impact:** New file changes in the affected project stop being indexed until repair. Search results gradually go stale.

**Recovery:**
```bash
cd <affected-project-root>
gmax index --reset
```

This rebuilds the project's vectors from scratch. For a 100k-chunk project on Apple Silicon, expect ~5–15 minutes.

**Detection (manual):**
```bash
grep "DATA CORRUPTION" ~/.gmax/logs/daemon.log | tail
```

**Fix:** None planned. Compaction interrupts (laptop sleep mid-write, kill -9, disk pressure) are rare enough that the detect-and-back-off behavior is sufficient.

## Daemon fails to attach FSEvents on every project after a forced kill

Verified 2026-05-07 on macOS Darwin 25.4.0.

After a daemon is `kill -9`'d (or otherwise terminated without graceful shutdown), the kernel can hold its FSEvents subscription slots open for an indeterminate period. A subsequently-started daemon then sees this in `~/.gmax/logs/daemon.log`:

```
[daemon] Failed to watch <project1>: [Error: Error starting FSEvents stream]
[daemon] Failed to watch <project2>: [Error: Error starting FSEvents stream]
...
[daemon] Started (PID: <new>, N projects)
```

Every registered project fails to attach in a row. The daemon itself is healthy — daemon-mediated search, peek, extract, trace, etc. all work because they query LanceDB directly. The broken capability is **incremental reindexing**: file edits won't be picked up automatically.

**Impact:** Search results gradually go stale on edited files until either (a) you manually reindex, or (b) the kernel releases the FSEvents slots (typically requires a reboot).

**Detection:**
```bash
grep "Failed to watch" ~/.gmax/logs/daemon.log | tail
```

**Recovery (in order of preference):**

1. **Reboot.** Reliable. The kernel resets all FSEvents state at boot, and the daemon will subscribe cleanly on next startup.
2. **Reindex manually as needed** until reboot. In each project where you've made meaningful edits:
   ```bash
   cd <project-root>
   gmax index
   ```
   This is a no-op for unchanged files (skipped via the MetaCache mtime+size check), so it's cheap to run repeatedly.

**Why not just `sudo killall fseventsd`?** Modern macOS (Darwin 25.x and later) protects `fseventsd` under System Integrity Protection. Even with sudo, the kill is refused unless you boot into Recovery and disable SIP — which is far heavier than the problem warrants.

**Avoiding the issue:** Always shut down the daemon gracefully:
```bash
gmax watch stop --all
```
This routes through IPC and lets the daemon unsubscribe cleanly. Avoid `kill -9` on `gmax-daemon` unless absolutely necessary.

**Fix:** Planned. The daemon already falls back to a 5-minute polling catchup when FSEvents *overflows* mid-run (see commit `5254c55`). The same fallback should engage when FSEvents fails to *subscribe* at startup. Until that ships, manual workarounds above apply.

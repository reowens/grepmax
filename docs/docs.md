# Docs

## Current reliability work

The ordered reliability fixes are implemented and release verification is in progress:

1. Native cache limits now reach the actual SDK Session. The old positional Session was silently
   ignored; a native regression fails with the old wiring and passes with the fix.
2. Production packaging uses the pinned official Lance SDK runtime without its unused provider
   dependency manifest. Fresh packed-consumer audit and native runtime smoke pass; releases gate both.
3. Native query deadlines apply to production query execution. Importer/path scans stream 512-row
   batches; row fallbacks apply output caps before materialization. Temporary LIKE+limit regression passes.
4. MCP routes each request to its selected store; status includes mounted/offline store metadata.
   Real disk-image eject/remount passed while MCP remained running, with no reindex or secondary daemon.
5. Unsupported daemon commands require `gmax watch restart` and never create a fallback reader.
   Transport absence and in-process secondary access remain supported.

Longer memory behavior still needs observation under ordinary sessions. Compare `Resource snapshot:`
and `Compaction result:` records across cycles, accounting for hdev's memory guard. Do not force
full rewrites of the live store to produce evidence.

[Future Sessions](future-sessions.md) contains the detailed local evidence and precautions.
Use runlist to consume the latest handoff and claim plan work; older archived notes describe
historical states. The upstream FTS panic is resolved in the shipped LanceDB 0.38.0 GA pin;
the rebuild guard remains as a recovery tripwire.

## Deferred work

- [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) requires a
  meaningfully better measured model before implementation. The earlier 768d tier lost to 384d.
- [Semantic Search — Open Backlog](plans/2026-05-25-semantic-search-landscape.md) keeps
  PPR, HyDE, query expansion and semantic caching gated on measured misses or latency.
- Static graph results remain approximate for dynamic dispatch, reflection and receiver binding;
  dead symbols and test candidates are hypotheses. See [Known Limitations](known-limitations.md).

Never start a summarizer or multi-GB LLM without current explicit user authorization.

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [macOS Kernel-Zone Panic Incident - 2026-08-04](2026-08-04-macos-kernel-zone-panic-incident.md) | Active |
| [Performance Review — 2026-08-04](2026-08-04-performance-review.md) | Active |
| [2026 08 17 Gmax Agent Facing Health Audit](2026-08-17-gmax-agent-facing-health-audit.md) | Active |
| [2026-08-25 Release Triage — Retrospective](2026-08-25-release-triage-retrospective.md) | Active |
| [Embedding Layout Decision](embedding-layout-decision.md) | Active |
| [Future Sessions](future-sessions.md) | Active |

## Planned

| Doc | Status |
|-----|--------|
| [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Planned |

## Reference

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Reference |
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 69 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Maintenance Observability](archived/maintenance-observability.md) | Archived: Released v0.26.43; source b59c6ad and tag e056fe0, CI 37090715709 passed all 1470 tests plus typechecks, formatting, build and repository audit. Global install completed and daemon PID 82555 confirmed 0.26.43 over IPC. Search and read-only doctor passed. The first scheduled live pass completed in one attempt in 42.3 seconds, with physical bytes 16.53 GB to 14.85 GB; new resource and compaction JSON records were verified in the log and status. Consumer sharp finding remains documented separately. |
| [LanceDB 0.31 → 0.38 Upgrade](archived/lancedb-0.38-upgrade.md) | Archived: Shipped initially in v0.26.23 with a beta overlay, then replaced by the LanceDB 0.38.0 GA pin. The upstream FTS fix is included; the v0.26.27/0.26.28 canary ran September 7–16 with zero optimize failures, FTS rebuilds or panics. The drop-and-rebuild guard remains a recovery tripwire. The body below preserves the August prerelease investigation as historical evidence. |
| [Compaction Disk Safety](archived/compaction-disk-safety.md) | Archived: Released v0.26.42 with fresh compaction snapshots, a two-attempt cap, and fresh disk headroom checks. All 1452 tests passed locally and in CI; installed daemon PID 55958 confirmed version 0.26.42 over IPC. The recovered store remains around 14 GB with roughly 112 GB free. |
| [Agent Reliability Hardening](archived/agent-reliability-hardening.md) | Archived: Implemented all six phases; 1439 tests across 154 files pass, both typechecks and build pass, and compiled CLI/graph smoke checks pass. |
| [Lance FTS Incremental-Merge Panic — Upstream Pursuit](archived/lance-fts-merge-upstream.md) | Archived: Closed. lance-format/lance#8310 was fixed by lance#8312 (lance 11.0.0-beta.22); gmax pins @lancedb/lancedb 0.38.0 GA (lance 11.0.0). The 0.26.27/0.26.28 canary on the GA pin ran 2026-09-07 to 2026-09-16 with zero optimize failures, FTS rebuilds, or panics. The drop-and-rebuild guard stays as a tripwire. |
| [Daemon Read Path](archived/daemon-read-path.md) | Archived: Shipped in v0.26.28 on 2026-09-08 (daemon PID 22835 restarted onto it at 10:29 -0700, ping capabilities.readVerbs 1, platform-package lance binary). Verified over a real socket: seven read commands with zero fallback lines and byte-identical output to GMAX_NO_DAEMON=1; scripts/sandbox-smoke.sh --strict 20/20 PASS; only the live daemon holds a live reader marker. Remaining: a one-time acceptance from a Claude Code sandboxed shell with only allowUnixSockets set, dead-marker pruning (non-goal here), and removing the unknown-command fallback one release later. |
| [LanceDB FTS Panic Remediation](archived/lancedb-fts-panic-remediation.md) | Archived: H1 is falsified. The live daemon has run LanceDB 0.31 against the shared store since 2026-08-04T06:06:47 because the global install is a symlink to the working tree, and it recorded six FTS optimize panics in that window. Both 0.30 and 0.31 ship the identical lance-index 7.0.0 crate, so the upgrade never had a mechanism to fix the panic. The shipped guard nevertheless recovers every occurrence and the store converges, so the operator has approved shipping 0.31 as a no-worse runtime rather than pinning back. |
| [Mcp Server Migration](archived/mcp-server-migration.md) | Archived: The Server-to-McpServer migration shipped in `e80daca`; the result-shape follow-up shipped in `04a87a4`. The current server registers 27 tools with Zod schemas, explicit registered-project scoping, protocol coverage, and subsequent lifecycle/performance hardening. |

- Use `runlist list` or `runlist json` for the full inventory.
<!-- GENERATED:dotmd:end -->

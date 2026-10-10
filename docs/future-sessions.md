---
type: doc
status: active
created: 2026-10-03T02:39:56Z
updated: 2026-10-10T08:45:12Z
audience: internal
summary: Short orientation to the sole execution plan; historical follow-ups are not a queue.
---

# Future Sessions

## Current focus

Read [Gmax Delivery Plan](plans/gmax-delivery.md), the sole execution plan.
Milestone A is complete in published 0.26.85. The accepted local 0.26.86 MCP
startup package is now installed in both existing Node runtimes and both plugin
scopes, with a ready/active daemon. All 314 package files and 15 plugin files match
the accepted local tarball. Settings and unrelated Depot edits were preserved.
Existing clients adopt the startup change on reconnect; no sessions were forcibly
killed. npm publication of 0.26.86 awaits fresh authentication/MFA.

1. **A, complete:** bounded index segments/merging, partial row relocation,
   reference-proven orphan reclamation, durable read accounting and daemon
   admission. Local full release-source tests and packed-consumer checks passed;
   installed temporary-store acceptance preserved all 29 fields. Do not reopen
   preplanning or repeat unchanged cleanup/timing observations.
2. **B, delivering:** 0.26.86 lazy MCP startup is reviewed, integrated and locally
   accepted (2,311 source tests; three-session RSS down 32.7%). Both installations,
   plugin scopes, daemon and installed startup checks passed.
   npm publication is deferred: the user cannot authenticate now and prohibited
   preview use. Do not retry authentication or use the preview without new steering.
   Do not claim
   a published release or close B until it succeeds. Evidence and installation
   scripts are in `/private/tmp/gmax-mcp-startup-evidence/`.
3. **C, queued:** finish one explicitly selected document-search consumer rollout.

## Work discipline

Zero GitHub CI. GitHub Actions is disabled for this repository. Six workflows were
preserved byte for byte in `automation/legacy-github-workflows/`, outside the active
directory. The release hook returns after pushing; checks, publication and
installation are explicit local operations. Independent Depot execution is an
option for future work, not an implemented provider. No CI polling or waiting.

All agents are stopped. Root owns integration/review; do not resume independent
feature work until the user selects it. Keep one plan and close delivered subitems.
Run tests locally for actual changes, not repeated unchanged storage studies.
Historical audits, old plans and research proposals remain reference evidence.

Private release proof is `/private/tmp/gmax-milestone-1-evidence/`.

## Boundaries

Preserve critical-only host policy, small GPU, maximum two workers, current client
settings and sessions. No manual live prune/rebuild, full-table compaction or large
model startup is authorized by this orientation. Watching stays in standalone Gmax;
Hetchy Developer cannot be a runtime dependency. Depot account/provider work belongs
to platform; preserve the two existing uncommitted generic collector edits.

The previous long orientation is preserved in the local recenter evidence under
`/private/tmp/gmax-recenter-20261009/`; historical plans retain their own evidence.

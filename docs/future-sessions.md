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
0.26.85 is published, installed in both existing Node runtimes and both plugin
scopes, and serving from a ready/active daemon. Registry integrity/source and all
313 installed package files plus 15 plugin files match. Settings, sessions and
unrelated Depot edits were preserved. Milestone A is complete.

1. **A, complete:** bounded index segments/merging, partial row relocation,
   reference-proven orphan reclamation, durable read accounting and daemon
   admission. Local full release-source tests and packed-consumer checks passed;
   installed temporary-store acceptance preserved all 29 fields. Do not reopen
   preplanning or repeat unchanged cleanup/timing observations.
2. **B, next:** review and complete the paused MCP lazy-startup patch in
   `/private/tmp/gmax-session-overhead`. It is not integrated or released.
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

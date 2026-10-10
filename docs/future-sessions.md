---
type: doc
status: active
created: 2026-10-03T02:39:56Z
updated: 2026-10-10T10:14:20Z
audience: internal
summary: Short orientation to the sole execution plan; historical follow-ups are not a queue.
---

# Future Sessions

## Current focus

Read [Gmax Delivery Plan](plans/gmax-delivery.md), the sole execution plan.
Milestones A and B are complete. 0.26.86 is published and installed in both existing
Node runtimes and plugin scopes, with a ready/active daemon. Registry integrity and
byte identity with the source-qualified accepted tarball were verified; all 314
package files and 15 plugin files match. Settings and unrelated Depot edits were
preserved. Existing clients adopt the startup change on reconnect; no sessions
were forcibly killed. The successful publication used CLI/user MFA without the
preview or GitHub CI.

1. **A, complete:** bounded index segments/merging, partial row relocation,
   reference-proven orphan reclamation, durable read accounting and daemon
   admission. Local full release-source tests and packed-consumer checks passed;
   installed temporary-store acceptance preserved all 29 fields. Do not reopen
   preplanning or repeat unchanged cleanup/timing observations.
2. **B, complete:** 0.26.86 lazy MCP startup is reviewed, integrated and locally
   accepted (2,311 source tests; three-session RSS down 32.7%). Both installations,
   plugin scopes, daemon and installed startup checks passed.
   npm publication, registry identity, installed files and active serving daemon
   are verified. The registry omits gitHead; exact tarball identity binds this
   release to the accepted source record. Include provenance in the CI review.
   Evidence is in `/private/tmp/gmax-mcp-startup-evidence/`.
3. **Next session first:** review the whole CI/release setup and user requirements,
   including release-only CI and npm trusted publishing. Future policy is not locked.
4. **C, queued:** finish one explicitly selected document-search consumer rollout
   after the requested review and user steering.

## Work discipline

GitHub Actions is currently disabled for this repository. Six workflows were
preserved byte for byte in `automation/legacy-github-workflows/`, outside the active
directory. The release hook returns after pushing; checks, publication and
installation are explicit local operations. Independent Depot execution is an
option for future work, not an implemented provider. The earlier zero-GitHub-CI
direction explains the current state; the latest request reopens future policy.
Review all triggers, duplication/minutes, local/Depot checks, Linux/macOS/build-box
coverage, publication and installation before proposing changes. The preserved
release workflow contains npm OIDC trusted publishing; moving it and disabling
Actions stopped that path. Direct CLI/MFA is not a permanent publishing decision.
Do not restore or trigger automation, delete preserved YAML or change credentials
during the review without a selected, authorized change.

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

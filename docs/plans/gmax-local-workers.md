---
type: plan
status: partial
created: 2026-10-24T03:25:08Z
updated: 2026-10-24T06:56:02Z
surfaces:
  - development
  - workers
modules:
  - scripts/local-worker.cjs
  - scripts/assemble-bounded-runtime.cjs
  - scripts/prepare-bounded-runtime.cjs
domain: Run selected Gmax development jobs on the existing user-owned worker pool
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
  - docs/plans/gmax-delivery.md
related_docs:
  - CLAUDE.md
current_state: "The Gmax repository entry, named task catalog, frozen source inputs, existing-pool dispatch, Windows command closure and result/artifact checks are implemented. One local fixture invocation passed 12/12 without workers or tools; two final narrow edits passed syntax checks only. P3 dependency preparation and the first live typecheck passed. A reusable explicit prepare command is implemented with 16 local fixtures passing; its live execution and other tasks/OS routes remain unaccepted."
next_step: "Reusable preparation is implemented. When separately selected, wire ordinary Gmax development commands to the local-worker path, retaining named task/machine selection. No check or live preparation is queued; Windows preparation and the remaining OS/task acceptance stay open."
summary: "Named jobs, reusable explicit dependency preparation and P3 typecheck acceptance are recorded. Matching caches reuse without installation; missing caches use frozen manifests with scripts disabled. No cloud fallback or automatic placement."
---

# Gmax on the local worker pool

## Outcome and authorization

A requested Gmax job runs once on an eligible user-owned machine, with the source
revision, chosen machine, command, result and artifacts recorded together. Local
means the existing owner-operated Linux, Windows and Mac pool, including its
normal authenticated SSH/Worker transport; it excludes hosted cloud builders.

The source integration is built. The user-selected [P3 first live typecheck](#p3-first-live-typecheck) passed with matching prepared dependencies; this accepts only that task and machine.
The [delivery session map](gmax-delivery.md#session-ownership-and-current-direction)
keeps publication, active backend evaluation and P3 runtime ownership separate.
This plan adds no release gate,
CI workflow, scheduled run, benchmark, enrollment replacement or model backend.
The [local-only rule](../../CLAUDE.md#local-checks-and-remote-execution) applies;
the existing manual release workflow remains the sole CI exception.

## Existing pieces and the actual gap

- The platform runner has placement, admission, source transfer, usage logs,
  cancellation and result markers: `platform/scripts/worker-job.mjs:1-40` and
  `platform/scripts/lib/pool-placement.mjs:1-44`.
- Its source root is the platform repository (`worker-job.mjs:49` imports
  `REPO_ROOT`; `scripts/lib/repo-map.mjs:14` defines it). Named Worker commands
  are platform `just` tasks (`packages/worker/src/job-executor.mjs:13-22`).
  Passing a Gmax path or arbitrary shell command is not a project integration.
- The existing external project descriptor accepts Backfeed only and is Mac
  specific (`scripts/lib/native-projects.mjs:32,67-74`). Reuse its constrained
  project/source pattern without turning it into an unrestricted command door.
- Windows stages platform-specific source at `C:\ProgramData\<worker-root>\jobs\platform`
  (`scripts/lib/worker-windows.mjs:13`). Gmax needs its own scoped job inputs.
- Gmax's native packaging already validates source and artifact identities:
  `scripts/assemble-bounded-runtime.cjs:17-40` and
  `scripts/prepare-bounded-runtime.cjs:20-57`. Keep those existing checks.

`platform/` references above are relative to the sibling platform checkout;
the host's worker-pool plan owns those files
and the fleet. This plan owns only the Gmax integration, not fleet repair.

## Job selection and machine roles

The developer selects a task and an exact enabled local roster machine. This
first implementation requires `--worker`; automatic placement is not implemented.
It does not add tasks or start an OS matrix. The task roles are:

- Linux: ordinary TypeScript/Python work, packaging and explicitly selected
  Linux native builds. P3 is eligible only under its existing desktop-idle policy;
  Dell Linux execution uses its current supported, admitted route.
- Mac: Darwin ARM64 builds, filesystem behavior and explicitly selected MLX/Metal
  work. Use an available approved Mac route; do not enable held Air/Pro rows.
- Windows: requested npm installation, CLI and Windows compatibility cases.
  Do not run the POSIX `rm`/`chmod` build lifecycle unchanged on Windows or claim
  Windows bounded-native-helper support; its artifact is not currently shipped.

Task definitions are explicit dependency preparation, typecheck, selected unit
tests, package creation, platform compatibility and native build. Each maps to a fixed command/argument
shape using existing Gmax scripts; test selectors are validated repository paths.
Native build and MLX work run only when explicitly selected. Creating a package
does not automatically run consumer tests, native qualification or release:check.
An aggregate is allowed only when the user explicitly selects that aggregate.

## Implementation sequence

- [x] **1. Register Gmax and its named tasks (source).** Add a developer-only entry under
  `scripts/` and task definitions in the existing platform job path. Extend the
  platform-only project/root selection additively, preserving existing platform
  and Backfeed behavior. No public Gmax CLI or separate job server is needed.
- [x] **2. Connect the local OS routes (source; live execution unaccepted).** Reuse the pool roster, authentication,
  admission, queue, resource budgets, locks and cancellation. Materialize the
  selected committed Gmax source in the existing job workspace mechanism, scoped
  separately from platform sources and live Gmax indexes. Carry declared native
  artifacts as hashed inputs. Missing tools, enrollment, capacity or platform
  support produce a clear held/refused result; they do not trigger installs,
  policy changes, another transport or a cloud job.
- [x] **3. Return results and artifacts (source).** Record job ID, commit/source digest,
  OS/architecture, tool versions, task/arguments, exit code and timings. Return
  selected logs and artifacts with hashes; reuse unchanged compatible artifacts.
  Key caches by source, lockfile, platform and toolchain. A lost completion is
  unknown until reconciled, and cancellation stays requested until acknowledged;
  neither causes an automatic rerun on another machine.

For an explicitly chosen machine, refusal stays on that request. Existing generic
pool fallback behavior must not silently rerun Gmax work. A job can never count
an absent result, skipped platform or different source as a successful result.

## Completion and verification scope

The source entry uses the existing local routes and produces the recorded
result/artifact shape. Source fixtures do not establish live execution. The separately recorded
[P3 typecheck](#p3-first-live-typecheck) accepts that selected Linux task; other
tasks and OS routes remain open.

Each assignment returns within 45 minutes and uses at most 1 focused test
invocation. Select the smallest test relevant to the changed routing/contract;
do not run a full release suite, repeat accepted native qualification or load
models to qualify this integration. A live job is run only when the user selects
that task and machine; that job uses the assignment's one test allowance when it
is acceptance work. No automatic three-platform acceptance campaign is queued.

Close a platform's live acceptance only after the requested job returns its real
machine/source/result and artifact evidence. An unrun platform remains unrun;
it does not hold the current release or authorize extra work.

## Ownership and boundaries

the host's worker-pool plan owns placement and transport;
the host's worker-machine plan owns machine-specific admission
and installed repair. Their existing stops and
holds remain in force. Reuse the roster; do not create a second machine registry.
The [Gmax delivery plan](gmax-delivery.md) owns the release handoff and historical
proof. The host's fleet-compute plan owns shared cache and broader
scheduling work; this integration does not reopen it. These paths are relative
to the enclosing host workspace, not this Gmax repository.

[Backend evaluation](colbert-backend-evaluation.md) owns its active experiment
session; the local-worker catalog does not run that experiment. The platform
the host's session plan thermal-containment section owns the indexing pause. A
selected worker job is not permission to resume indexing, restart its daemon or
change its bounded service. Installed enrollment follows
the host's developer-setup plan; a Gmax capability
refusal remains a refusal rather than a reason to change enrollment or transport.

Work alone unless the user approves a stated agent count. The source-only
implementation evidence below is distinct from the selected P3 first-use receipt.
Neither authorizes another check, agent, release or runtime operation.

## Source checkpoint and limits

Source integration receipt (private record)
records exact files, hashes, the local test command and the proof boundary.

The Gmax entry is `scripts/local-worker.cjs`; it locates the adjacent platform
checkout and calls `platform/scripts/gmax-worker.mjs`. The catalog and source
validation live in `platform/scripts/lib/gmax-project.mjs`; the worker-side task
is `platform/scripts/gmax-worker-task.mjs`. Windows admits that exact bridge and
its three-file source closure in `scripts/lib/worker-windows.mjs`. The shared
`worker-job.mjs:runJob` has an opt-in `allowFallback: false` and named-job memory
demand; existing fallback behavior is unchanged for other callers.

Linux first reads the installed Developer configuration. Only its explicit
`worker-sender-not-enrolled` state selects the pool's existing SSH route.
An enrolled Worker currently has no Gmax project capability and refuses; a timeout,
expired or unconfirmed configuration also refuses. No enrolled refusal switches
to SSH. Mac and Windows use their existing roster routes and admission; held
Mac rows are not enabled. There is no automatic placement in this version.

One `node --test` invocation covered the two focused integration files: 12 passed,
0 failed/skipped. The transports, Git capture and compiler were mocked; temporary
files were owned by the fixtures. It covered all three OS dispatch shapes,
Windows closure mapping, committed-source validation, matching receipts/artifacts,
missing preparation, failure handling and opt-in no-fallback versus legacy fallback.
After that run, Windows input separators were normalized at the receiver and the
new explicit memory-option validation was scoped to leave legacy callers alone.
Both final edits passed `node --check`; the test suite was not repeated. Those
edits have syntax evidence only, not a second behavioral qualification.

## Repository command and prepared inputs

These are invocation examples, not queued jobs:

```bash
node scripts/local-worker.cjs describe
node scripts/local-worker.cjs prepare --worker p3 --ref <full-commit>
node scripts/local-worker.cjs run --task typecheck --worker p3 --ref <full-commit>
node scripts/local-worker.cjs run --task unit --worker dell-win --ref <full-commit> --test tests/core.test.ts
```

`describe` is static and contacts no worker. `run` captures only the selected
committed Gmax tree; dirty working files are not job inputs. Requests accept fixed
tasks, exact test-file selectors and a maximum 900-second execution deadline.
Source is capped at 64 MiB and refuses credentials, links, traversal and case
collisions. Each request is unique and never automatically reruns elsewhere.

Execution tasks do not install dependencies. The explicit `prepare` command
creates or reuses the matching directory beside the worker's platform clone:

```text
../project-cache/gmax/<pnpm-lock-sha256>-<node-platform>-<arch>-<node-version>/
  preparation.json
  node_modules/
  native-artifacts/    # existing qualified inputs, required for package creation
  runtime/             # required only for the CLI-version compatibility task
```

`preparation.json` declares `schemaVersion: 1`, `project: "gmax"`, `lockSha256`,
`platform` (`linux`, `darwin` or `win32`), `architecture` and `nodeVersion`.
The initial unit task covers selected Vitest files; a separate Python task is
not implemented. Compatibility also requires `runtimeCommit` and a `runtimeFiles` path-to-SHA-256
inventory including `package.json` and `dist/bin.js`. The job verifies that inventory
and checks only CLI version startup; it is not complete Windows compatibility.
The P3 first-use receipt records a manifest-only dependency preparation, with
install scripts disabled, for typechecking. The reusable producer below is
implemented; other workers have no live preparation accepted here. Missing
preparation returns a refusal before executing tools. Native builds use the installed offline Cargo
cache and two build jobs; absent tools/dependencies fail without provisioning.

Results return under the platform checkout's `tmp/gmax-jobs/<jobId>/`, with
`result.json`, `stdout.log` and the requested artifact. A package returns
`package.tgz`; a native build returns `gmax-bounded-maintenance`. Native build
output alone is not qualified for release. Package creation reuses existing
qualified native inputs and does not run consumer/native/release test suites.

## P3 first live typecheck

P3 receipt (private record) records the
single selected run, exact source/cache identities, tool versions, admission and
transport result. `scripts/local-worker.cjs` dispatched committed Gmax source
`55b6d43ee5c64b37a82fdcf86aaee3b0091aa192` through the existing pool to P3. Its
`tsc --noEmit` returned exit 0; no fallback or retry ran. This checks committed
source only, not other sessions' concurrent dirty files.

The matching cache beside P3's platform clones was prepared from that commit's
`package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` with frozen-lockfile
installation and install scripts disabled. The receipt owns the exact path,
Node/TypeScript versions, preparation command and hashes. Only dependency
manifests were materialized for preparation; no Gmax service or model started.
The pool's Node version differs from the interactive shell and is the cache key.

This is live Linux typecheck acceptance, not unit tests, runtime/native package
qualification, Mac/Windows acceptance or a completed worker rollout. The reusable
cache producer below has separate source evidence; the remaining limits stay open.
No additional check is queued; P3 indexing remains paused under its host owner.

## Reusable dependency preparation

`node scripts/local-worker.cjs prepare --worker <name> --ref <full-commit>` uses
`scripts/gmax-worker.mjs:parseGmaxArgs` to select the fixed `prepare` task through
the existing named-worker admission, deadline and result path. It supports Linux
and Darwin source routes; Windows preparation remains unavailable. It does not
run another task or enable a held worker.

`scripts/lib/gmax-project.mjs:prepareGmaxDependencies` materializes only committed
`package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`. A matching cache must
retain identical manifests and the expected lock/platform/architecture/Node
identity. It returns `disposition: reused` without invoking pnpm. An inconsistent
cache refuses without replacing it.

A missing cache uses a per-key lock and private staging directory. The only
installation command is `pnpm install --frozen-lockfile --ignore-scripts
--reporter=append-only`, within the existing task deadline and isolated environment.
Manifest identity is checked again before the cache is published by rename;
failed preparation removes its owned staging and lock. A concurrent preparation
refuses without retry. Installation scripts, native build/qualification, models,
indexing and runtime/native artifacts are not prepared by this command.

Preparation source receipt (private record)
records the one local invocation: 16 cases passed, including the existing routing
regressions, install-once/reuse-without-tools, cleanup and cache conflicts. Real
filesystem fixtures used a fake installer; no worker was contacted or pnpm run.
This is source evidence, not live preparation acceptance. The existing P3 cache
and typecheck receipt above remain unchanged.

## Version History

- **2026-10-24T06:56:02Z** Status: in-session → partial — Reusable explicit manifest-only preparation and matching-cache reuse implemented. One focused local invocation passed 16/16; no live worker or installation ran.
- **2026-10-24T06:52:37Z** Started (active → in-session).
- **2026-10-24T06:52:37Z** Status: partial → active — User selected reusable manifest-only dependency preparation and cache reuse, 0 agents, 1 focused local test.
- **2026-10-24T06:33:44Z** Status: in-session → partial — Matching P3 dependencies prepared; single selected local-worker typecheck passed on frozen source. Other tasks and OS routes remain open; no further checks queued.
- **2026-10-24T06:31:08Z** Started (active → in-session).
- **2026-10-24T06:31:08Z** Status: partial → active — User approved P3 dependency preparation and one local-worker typecheck, with 0 agents.
- **2026-10-24T03:58:56Z** Status: in-session → partial — Source entry/catalog, committed inputs, existing local-pool dispatch, Windows closure and result/artifact handling implemented. One focused local invocation passed 12/12 with mocked transports/tools. Two final fixes syntax-checked only. No worker, cache preparation, installed capability, automatic placement or live acceptance claimed.
- **2026-10-24T03:30:28Z** Started (planned → in-session).

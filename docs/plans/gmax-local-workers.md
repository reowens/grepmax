---
type: plan
status: planned
created: 2026-10-24T03:25:08Z
updated: 2026-10-24T03:25:08Z
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
related_docs:
  - CLAUDE.md
current_state: Plan only. The pool runs platform jobs and has a Backfeed-specific Mac project path; Gmax has no registered project/task path. No worker was contacted and no job, test, installation or release ran for this plan.
next_step: On implementation approval, add the bounded Gmax project/task definitions to the existing pool and its repository entry point, then connect the supported local OS routes. Work alone; no cloud jobs or current-release work.
summary: Use existing Linux, Windows and Mac machines for selected Gmax jobs, with fixed task definitions, source identity, resource admission and returned artifacts. No cloud fallback or automatic verification rounds.
---

# Gmax on the local worker pool

## Outcome and authorization

A requested Gmax job runs once on an eligible user-owned machine, with the source
revision, chosen machine, command, result and artifacts recorded together. Local
means the existing owner-operated Linux, Windows and Mac pool, including its
normal authenticated SSH/Worker transport; it excludes hosted cloud builders.

The user requested this plan. Implementation and live jobs have not started.
The current release belongs to another session. This plan adds no release gate,
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
Worker pool (private record) owns those files
and the fleet. This plan owns only the Gmax integration, not fleet repair.

## Job selection and machine roles

The developer selects a task and optionally a local machine. Auto placement may
choose only a compatible, enabled local roster entry before execution starts.
It does not add tasks or start an OS matrix. Begin with these declared roles:

- Linux: ordinary TypeScript/Python work, packaging and explicitly selected
  Linux native builds. P3 is eligible only under its existing desktop-idle policy;
  Dell Linux execution uses its current supported, admitted route.
- Mac: Darwin ARM64 builds, filesystem behavior and explicitly selected MLX/Metal
  work. Use an available approved Mac route; do not enable held Air/Pro rows.
- Windows: requested npm installation, CLI and Windows compatibility cases.
  Do not run the POSIX `rm`/`chmod` build lifecycle unchanged on Windows or claim
  Windows bounded-native-helper support; its artifact is not currently shipped.

Initial task definitions are typecheck, selected unit tests, package creation,
platform compatibility and native build. Each maps to a fixed command/argument
shape using existing Gmax scripts; test selectors are validated repository paths.
Native build and MLX work run only when explicitly selected. Creating a package
does not automatically run consumer tests, native qualification or release:check.
An aggregate is allowed only when the user explicitly selects that aggregate.

## Implementation sequence

- [ ] **1. Register Gmax and its named tasks.** Add a developer-only entry under
  `scripts/` and task definitions in the existing platform job path. Extend the
  platform-only project/root selection additively, preserving existing platform
  and Backfeed behavior. No public Gmax CLI or separate job server is needed.
- [ ] **2. Connect the local OS routes.** Reuse the pool roster, authentication,
  admission, queue, resource budgets, locks and cancellation. Materialize the
  selected committed Gmax source in the existing job workspace mechanism, scoped
  separately from platform sources and live Gmax indexes. Carry declared native
  artifacts as hashed inputs. Missing tools, enrollment, capacity or platform
  support produce a clear held/refused result; they do not trigger installs,
  policy changes, another transport or a cloud job.
- [ ] **3. Return results and artifacts.** Record job ID, commit/source digest,
  OS/architecture, tool versions, task/arguments, exit code and timings. Return
  selected logs and artifacts with hashes; reuse unchanged compatible artifacts.
  Key caches by source, lockfile, platform and toolchain. A lost completion is
  unknown until reconciled, and cancellation stays requested until acknowledged;
  neither causes an automatic rerun on another machine.

For an explicitly chosen machine, refusal stays on that request. Existing generic
pool fallback behavior must not silently rerun Gmax work. A job can never count
an absent result, skipped platform or different source as a successful result.

## Completion and verification scope

Implementation is complete when the named Gmax entry uses the existing local
routes and produces the recorded result/artifact shape without changing other
projects. Record source implementation separately from live OS acceptance.

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

Worker pool (private record) owns placement and
transport; Dell workers (private record)
owns machine-specific admission and installed repair. Their existing stops and
holds remain in force. Reuse the roster; do not create a second machine registry.
The [Gmax delivery plan](gmax-delivery.md) owns the release handoff and historical
proof. Fleet compute (private record) owns
shared cache and broader scheduling work; this integration does not reopen it.

Work alone unless the user approves a stated agent count. No agents, remote jobs,
checks, source copies on workers, software installation or runtime changes were
performed to write this plan.

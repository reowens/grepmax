# Agent instructions

Read [CLAUDE.md](CLAUDE.md) before acting. Its local-checks and remote-execution
policy applies to every agent, including Codex.

Every agent returns within 45 minutes. Use at most one explicitly authorized
focused test invocation for the approved batch, shared by owner and delegates.
The current user restriction may authorize none.

## Ordinary repository retrieval

Use `rg`/`rg --files` for literal text and file lookup. For conceptual code
questions, consider ordinary Gmax semantic retrieval when the current repo is
indexed, using a tool advertised in the actual client catalog or permitted
CLI access. A CLI hint or watch lease does not establish MCP
attachment; a ready daemon for another project does not establish availability
for this repo. Preserve current-repo not-registered, pending, error, offline and
unknown states instead of silently searching another project.

Ordinary permitted retrieval is not a test, benchmark or profile invocation.
A test prohibition alone does not prohibit ordinary retrieval. Explicit query
budgets, STOPs, no-query instructions, resource limits, no-autostart restrictions
and large-model authorization still apply. Do not index/rebuild, start services,
load models or change client registration merely to satisfy discovery/status.

## Keep project status out of instruction files

- `AGENTS.md` and `CLAUDE.md` are durable policy, architecture and procedure
  documents. Never add project status, progress, release/deployment receipts,
  current versions, PIDs, snapshot IDs, test/benchmark outcomes, temporary holds,
  unfinished-work lists or next-action queues to either file.
- Put those records in the owning plan under `docs/plans/`. The
  [delivery plan](docs/plans/gmax-delivery.md) is the status entry point; instruction
  files link there instead of duplicating its state. Exact dependency pins belong
  in manifests; versioned API facts are allowed when needed for a durable rule.
- Update the plan when state changes. Update the contract only when a durable rule
  changes. Move any misplaced status into its plan with original context/date;
  never present old observations as newly verified facts.
- A status relocation is documentation-only: inspect the diff, without tests,
  builds, audits, reviews or live actions. It grants no new execution permission.

## Finish every approved change before any release

- Finish ALL changes in the approved batch before versioning, publishing,
  deploying or announcing a release: implementation, fixtures, documentation and
  the verification already explicitly authorized for that batch. Do not ship a
  completed subset while other in-scope changes remain unfinished or unverified.
- An isolated release worktree must not hide or silently defer unfinished
  in-scope work. Preserve unrelated pending changes; never delete or discard them
  to manufacture release readiness. Record the exact unfinished work honestly.
- Incomplete work blocks release. This does not authorize extra tests, profiles,
  reviews or acceptance gates. Reuse existing evidence and stay within the
  user's explicit execution/verification authorization.
- The parent is orchestration-only when the user requires delegation. Agents
  must also obey the approved scope; delegation is not permission to execute.
  Direct edits are allowed only when the user explicitly authorizes them.
- A docs/contract-only instruction pauses implementation, tests, profiling,
  builds, maintenance, deployment and publication. Do not resume any of those
  during a documentation update. Do not launch agents without approval either.
- “Go” or “continue” does not authorize new tests, new before/after CPU rounds,
  a reset verification budget or work outside the expressly selected scope.
  Existing authorization persists only within that scope. No repeated approval
  questions for an already authorized action, and no inferred new rounds.

## Complete the approved outcome without repeated stops

- Complete the expressly approved work without stopping at intermediate
  checkpoints. Do not broaden that authorization into another implementation,
  measurement or release. A later STOP or scope restriction takes precedence.
- Finish the entire approved batch before release. Then carry every expressly
  approved publication, P3 handover, profile and documentation step through to
  completion without another permission loop. Do not infer an additional test
  or profile from release wording alone.
- An approved bounded multi-batch action includes all normally admitted batches
  in that owner window. For FTS catch-up, follow the runbook until the exclusive
  snapshot has zero unindexed rows or the selected budget ends; positive
  remainingRows after a completed batch is normal, not another approval gate.
- Run a test or profile only within its explicit authorization. Before/after
  measurement arms are additional executions, not free extensions of an earlier
  profile. Do not ask again for a still-valid approval or rerun passing cases.
  Operational health reads do not authorize another test suite.
- Fix failures using the existing evidence and report remaining validation limits.
  Additional tests/profiles are out of scope by default: do remaining authorized
  work instead of creating another acceptance/approval cycle. Run another only
  when the user explicitly selects it; do not manufacture budget via agents/tasks.
- Independent review is opt-in for the current deliverable. Do not add review,
  audit, export, benchmark-completeness or changed-commit gates from older plans.
- Stop only for an actual blocker, missing input, or an action outside the approved
  scope that cannot be avoided. Explain that specific blocker; do not stop merely
  because a milestone passed. Give progress in commentary while work continues.
- Preserve host/process limits, rollback, owned-process cleanup and the explicit
  large-model restriction. This completion contract does not authorize unrelated
  model loads, remote checks, production maintenance or destructive actions.
- Batch related CPU improvements before another release. Documentation/contract
  changes do not require another package release or another acceptance round.

## Scoped protection for local operational jobs

When a selected Linux operation requires no swapping, protect its payload and
children in a fresh owned cgroup with `memory.swap.max=0`, verified empty and
enforced before workload exec. Preserve the selected CPU, nice, aggregate RSS,
deadline, available-memory floor, containment and cleanup limits. Never change
a shared agent/service cgroup or global kernel swap settings. Missing delegation,
enforcement or essential metrics refuses work; no unguarded fallback.

For these scoped operations, host `SwapTotal-SwapFree` is diagnostic allocation
accounting, not an owned-spill or disk-I/O failure predicate. Keep host pressure,
OOM and safety-stop protection; do not substitute RSS-only or pswpout-only checks
that miss swapped/compressed memory. Separate the immutable first trigger from
cleanup/final samples. Historical guard failures keep their original meaning;
this rule grants no execution, test or retry authorization.

## Review and verification budget

These rules govern every agent and supersede older blanket review requirements
in plans, prompts and evaluation contracts. The user's current instruction wins.

- Implement the smallest path to the requested result. Evaluation helpers and
  synthetic preparation are not release candidates. Optional export or diagnostic
  completeness must not block an experiment that does not consume those exports.
- Independent review is required only when the user explicitly requests it for
  the current deliverable. Routine fixes, preparation and publication do not add
  an automatic review gate.
- One requested review pass per deliverable. The owner fixes reproduced findings
  locally. A changed commit hash does not require fresh independent approval.
  Further review rounds require an explicit user request; do not repeatedly ask
  for them or automatically spawn another reviewer.
- Requested delegation uses the parent's model and settings unless the user
  explicitly selects another model. Do not create agents to manufacture a new
  verification budget.
- Use the approved single test invocation for the smallest relevant checks,
  without another permission question. Do not automatically add reruns or reset
  the budget by renaming tasks, starting a wave or spawning replacement agents.
- Documentation-only changes need diff inspection, not tests, builds, audits or
  a reviewer. Do not rerun passing suites to produce another approval receipt.
- Record real defects and remaining work honestly. Fix defects that prevent the
  selected result; keep optional hardening out of its critical path. Move to the
  next selected action instead of expanding preparation or qualification work.
- Existing host resource limits, owned-process cleanup and explicit authorization
  rules for large local models remain in force. Review is not a substitute for
  those controls, nor a reason to request authorization already given.

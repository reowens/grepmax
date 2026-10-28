# Agent instructions

Read [CLAUDE.md](CLAUDE.md) before acting. Its local-checks and remote-execution
policy applies to every agent, including Codex.

Every agent returns within 45 minutes. Use at most one focused test invocation
for each approved work batch, shared by the owner and delegates.

## Complete the approved outcome without repeated stops

- Treat “go”, “continue” and a request to release as instructions to complete the
  approved work, not permission to perform only the next checkpoint. Keep working
  through reversible preparation, implementation, deployment and documentation.
- For this repository, a release request includes publication, installation on P3,
  normal daemon handover, one bounded post-deployment CPU profile using the
  existing small models/service, recording results and proposing the next work,
  unless the user explicitly narrows that scope. Do not end after publishing and
  offer deployment/profile as a new task when they are already authorized.
- A “go” authorizes one focused test invocation if relevant. A profile included in
  the approved scope is also authorized once. Deployment health/version reads are
  operational confirmation, not a reason to start another test suite. Do not ask
  again for these already authorized actions or rerun passing cases.
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

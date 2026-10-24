# Agent instructions

Read [CLAUDE.md](CLAUDE.md) before acting. Its local-checks and remote-execution
policy applies to every agent, including Codex.

Every agent returns within 45 minutes and runs at most 1 test invocation.

## Review and verification budget

These rules govern every agent and supersede older blanket review requirements
in plans, prompts and evaluation contracts. The user's current instruction wins.

- Implement the smallest path to the requested result. Evaluation helpers and
  synthetic preparation are not release candidates. Optional export or diagnostic
  completeness must not block an experiment that does not consume those exports.
- Independent review is required only when the user requests it for the current
  work or for a product publication that still requires release review. Routine
  fixes, preparation and bounded local experiments do not add a review gate.
- One requested review pass per deliverable. The owner fixes reproduced findings
  locally. A changed commit hash does not require fresh independent approval.
  Further review rounds require an explicit user request; do not repeatedly ask
  for them or automatically spawn another reviewer.
- Requested delegation uses the parent's model and settings unless the user
  explicitly selects another model. Do not create agents to manufacture a new
  verification budget.
- Use the existing single test invocation for the smallest relevant checks.
  Additional invocations require an explicit user request. Do not reset this
  budget by renaming tasks, starting another wave or spawning replacement agents.
- Documentation-only changes need diff inspection, not tests, builds, audits or
  a reviewer. Do not rerun passing suites to produce another approval receipt.
- Record real defects and remaining work honestly. Fix defects that prevent the
  selected result; keep optional hardening out of its critical path. Move to the
  next selected action instead of expanding preparation or qualification work.
- Existing host resource limits, owned-process cleanup and explicit authorization
  rules for large local models remain in force. Review is not a substitute for
  those controls, nor a reason to request authorization already given.

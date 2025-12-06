---
name: osgrep
description: Semantic code search and call-graph tracing for AI agents. Finds code by concept, surfaces roles (ORCHESTRATION vs DEFINITION), and traces dependencies. Output is compact TSV for low token use.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

# osgrep: Scout + Trace

## Core Commands
- Search: `osgrep search "how does auth work"`
- Trace: `osgrep search --trace "AuthService"`

## Output (Default = Compact TSV)
- One line per hit: `path\tlines\tscore\trole\tconf\tdefined\tpreview`
- Header includes query and count.
- Roles are short (`ORCH/DEF/IMPL`), confidence is `H/M/L`, scores are short (`.942`).
- Use `path` + `lines` with `Read` to fetch real code.

## When to Use
- Find implementations: “where is validation logic”
- Understand concepts: “how does middleware work”
- Explore architecture: “authentication system”
- Trace impact: “who calls X / what does X call”

## Quick Patterns
1) “How does X work?”
   - `osgrep search "how does X work"`
   - Read the top ORCH hits.
2) “Who calls this?”
   - `osgrep search --trace "SymbolName"`
   - Read callers/callees, then jump with `Read`.
3) Narrow scope:
   - `osgrep search "auth middleware" src/server`

## Tips
- Previews are hints; not a full substitute for reading the file.
- Results are hybrid (semantic + literal); longer natural language queries work best.
- If results span many dirs, start with ORCH hits to map the flow.


# Security Policy

## Supported versions

Only the latest published `grepmax` release on npm receives security fixes. Upgrade with
`npm install -g grepmax@latest`, then run `gmax watch restart` so the running daemon picks up
the new build.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/reowens/grepmax/security/advisories/new)**.

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Helpful details:

- the gmax version (`gmax --version`) and the daemon version (`gmax status --json`)
- OS and architecture
- which component is involved (CLI, daemon, MCP server, Claude plugin hooks, embedding server)
- steps to reproduce, and what an attacker gains

gmax is maintained by one person. Reports are handled on a best-effort basis; you should get an
acknowledgement within a week. Fixes ship as a patch release, and the advisory is published
once the release is available. Reporters are credited unless they ask not to be.

## Security model

gmax is a local developer tool. Everything runs as the invoking user, and all state lives under
`~/.gmax/`. These boundaries are intended, and a way around any of them is in scope:

- **MCP** speaks only stdin/stdout to the client that spawned it. It has no network transport.
- **The daemon** listens only on a Unix-domain socket (`~/.gmax/daemon.sock`, mode 0600) inside
  a 0700 directory, and refuses to start if it cannot apply those permissions.
- **`gmax serve` and the Python embedding servers** bind to 127.0.0.1 only.
- **The optional local LLM** refuses non-loopback `GMAX_LLM_HOST` values.
- **Indexing** reads files only inside registered project roots and honors ignore rules. Indexed
  file contents should not cause code execution, command injection or writes outside `~/.gmax/`.
- **The Claude plugin hooks** should not run commands built from untrusted repository content.

Also in scope: a dependency vulnerability that is reachable through gmax, and an npm tarball
that ships files it shouldn't.

## Out of scope

- Attacks that already require running code as the same local user. That user can read
  `~/.gmax/` and the indexed source directly.
- Vulnerabilities in upstream dependencies (LanceDB, tree-sitter, MLX, ONNX Runtime and others)
  that are not reachable through gmax. Please report those upstream.
- Search results that show content from a project the user registered. That is intended.
- Resource exhaustion from deliberately indexing very large or adversarial trees on your own
  machine, unless it escapes the documented safety limits.

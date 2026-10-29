---
description: "Show Gmax setup and cached index status for the current repo"
allowed-tools: "Bash"
---

Run `Bash(gmax status --current --json)` and report the current repo, matched registered root, index state and daemon state. `not_registered` means Gmax is not set up for this repo, even if another project is indexed. Pending, error, unavailable or legacy/unknown metadata must retain those distinctions. Do not add/index/start services or search another project as part of a status request. MCP tools are available only when advertised by the current client's tool catalog; this plugin's CLI hints do not attach them. Use `gmax status` only when the user asks for all-project/store health.

# CLI daemon error guidance

`gmax add`, `gmax index`, `gmax remove`, `gmax project`, and `gmax symbols`
keep the daemon's failure reason and add a short manual next step for these
recognized failures:

- **Busy:** the existing reason names the pending exclusive operation when the
  daemon supplies it. Check `gmax status`, wait for that operation to finish,
  then retry the original command.
- **Initializing / not ready:** wait for startup to finish, check `gmax status`,
  then retry. Restarting is not the suggested response to normal startup.
- **Closing:** wait for shutdown to finish, check `gmax status`, then retry.
- **Unsupported command:** the live daemon may be older than the installed CLI
  or incompatible with it. Run `gmax watch restart` to use the installed version.
  Read commands that already give this hint keep their existing message.

Guidance is printed on stderr. Successful human/agent output, exit codes, and
store fallback/refusal rules are unchanged. A hint performs no status
request, retry, start, restart, or store access. Unknown failures keep their
existing message, and socket/privacy/sandbox refusals keep their existing rules.
Hints do not repeat command arguments, queries, environment values, or stacks.

Configuration errors remain separate: `gmax config` already prints valid
embedding modes, model tiers, query-log values, or the worker-count range and
`auto`. Use the choices in that error to correct the selected option. For worker
settings, `GMAX_WORKER_THREADS` takes precedence over stored `workerThreads`;
`gmax config --worker-threads auto` removes the stored override, so an environment
override still applies. A daemon restart is not a remedy for invalid input.

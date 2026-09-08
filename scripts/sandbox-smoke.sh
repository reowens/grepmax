#!/usr/bin/env bash
#
# sandbox-smoke.sh — run the read-only gmax commands under the two macOS
# seatbelt profiles that reproduce Claude Code's Bash sandbox, and report what
# each one does.
#
#   writes         writes to ~/.gmax denied, Unix sockets allowed
#                  (the daemon IPC path must carry every read command)
#   writes+sockets writes AND sockets denied — Claude Code's default profile
#                  (nothing can reach the store; every command must refuse with
#                  one actionable line, exit 2)
#
# Target state (docs/plans/daemon-read-path.md):
#   writes          every command exits 0
#   writes+sockets  every command exits 2 with a line naming allowUnixSockets
#
# Every read command is held to the same target since 0.26.28, when the daemon
# began serving the graph/rows/vector verbs. Against an older daemon the verb
# commands fall back in-process, hit the denied lease, and FAIL here — that is
# a real finding (the daemon on the socket is older than this checkout), not
# a script bug.
#
# macOS only: `sandbox-exec` has no Linux equivalent and CI runs on
# ubuntu-latest, so this is a manual gate. Uses the built dist in this
# worktree, never the globally installed gmax.
#
# Usage:
#   pnpm build && scripts/sandbox-smoke.sh [--strict] [--root DIR]
#                                          [--symbol NAME] [--query TEXT]
#
#   --strict   exit 1 if any row FAILs
#   --root     cwd for every command; must be an INDEXED project, otherwise
#              search legitimately returns nothing and exits 1. Defaults to this
#              checkout, which is wrong inside an agent worktree — pass the main
#              checkout there.
#   --symbol   symbol the graph commands look up (default resolveTargetSymbols)
#   --query    search query (default "store lease lock" — it must actually match
#              something in --root, or search exits 1 on an empty result set)
#
# It never starts, stops, or restarts a daemon, and every command it runs is
# read-only.

set -uo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "sandbox-smoke: macOS only (sandbox-exec); skipping." >&2
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GMAX_DIST="$REPO_ROOT/dist/index.js"
GMAX_HOME="$HOME/.gmax"

STRICT=0
SYMBOL="resolveTargetSymbols"
# Any query that reliably matches in --root; an empty result set exits 1 and
# would read as a sandbox failure that it is not.
QUERY="store lease lock"
RUN_ROOT="$REPO_ROOT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --root) RUN_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "sandbox-smoke: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$GMAX_DIST" ]]; then
  echo "sandbox-smoke: $GMAX_DIST not found — run 'pnpm build' first." >&2
  exit 2
fi

TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/gmax-sandbox-smoke.XXXXXX")"
trap 'rm -rf "$TMPDIR_RUN"' EXIT

PROFILE_WRITES="$TMPDIR_RUN/writes.sb"
PROFILE_BOTH="$TMPDIR_RUN/writes-sockets.sb"

cat >"$PROFILE_WRITES" <<EOF
(version 1)
(allow default)
(deny file-write* (subpath "$GMAX_HOME"))
EOF

cat >"$PROFILE_BOTH" <<EOF
(version 1)
(allow default)
(deny file-write* (subpath "$GMAX_HOME"))
(deny network*)
EOF

# Every one of these is read-only. ARGS is filled per name so a multi-word
# query survives (word-splitting a single string breaks `search`).
COMMANDS=(status search test peek trace impact extract similar symbols project)

args_for() {
  case "$1" in
    status)  ARGS=(status --agent) ;;
    search)  ARGS=("$QUERY" -m 3 --agent) ;;
    test)    ARGS=(test "$SYMBOL" --agent) ;;
    peek)    ARGS=(peek "$SYMBOL" --agent) ;;
    trace)   ARGS=(trace "$SYMBOL" --agent) ;;
    impact)  ARGS=(impact "$SYMBOL" --agent) ;;
    extract) ARGS=(extract "$SYMBOL" --agent) ;;
    similar) ARGS=(similar "$SYMBOL" --agent) ;;
    symbols) ARGS=(symbols --agent) ;;
    project) ARGS=(project --agent) ;;
    *) echo "sandbox-smoke: no args for $1" >&2; exit 2 ;;
  esac
}

# Commands WP-A routes through the daemon. Everything else is pending WP-B/WP-C.

FAILURES=0
declare -a ROWS=()

first_line() {
  # First non-empty line, trimmed of ANSI colour and clipped for the table.
  sed -e $'s/\033\\[[0-9;]*m//g' "$1" | grep -v '^[[:space:]]*$' | head -1 | cut -c1-88
}

run_case() {
  local profile_file="$1" name="$2" out
  out="$TMPDIR_RUN/$name.out"
  args_for "$name"
  ( cd "$RUN_ROOT" && sandbox-exec -f "$profile_file" node "$GMAX_DIST" "${ARGS[@]}" ) \
    >"$out" 2>&1
  echo "$?"
}

evaluate() {
  # $1 profile key, $2 command name, $3 exit code, $4 output file
  local profile="$1" code="$3" out="$4"
  if [[ "$profile" == "writes" ]]; then
    [[ "$code" == "0" ]] && echo PASS || echo FAIL
  else
    if grep -q "allowUnixSockets" "$out" && [[ "$code" == "2" ]]; then
      echo PASS
    else
      echo FAIL
    fi
  fi
}

for profile in writes writes+sockets; do
  case "$profile" in
    writes) pfile="$PROFILE_WRITES" ;;
    *) pfile="$PROFILE_BOTH" ;;
  esac
  for name in "${COMMANDS[@]}"; do
    code="$(run_case "$pfile" "$name")"
    out="$TMPDIR_RUN/$name.out"
    verdict="$(evaluate "$profile" "$name" "$code" "$out")"
    [[ "$verdict" == "FAIL" ]] && FAILURES=$((FAILURES + 1))
    ROWS+=("$(printf '%-14s %-14s %-8s %-7s %s' \
      "$profile" "$name" "exit=$code" "$verdict" "$(first_line "$out")")")
  done
done

echo
printf '%-14s %-14s %-8s %-7s %s\n' PROFILE COMMAND EXIT VERDICT "FIRST LINE"
printf '%s\n' "----------------------------------------------------------------------------------------------------"
printf '%s\n' "${ROWS[@]}"
echo
echo "PASS = meets the target · FAIL = regression (or a daemon older than this checkout)"
echo "failures: $FAILURES"

if (( STRICT && FAILURES > 0 )); then
  exit 1
fi
exit 0

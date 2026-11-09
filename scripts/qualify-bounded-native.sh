#!/usr/bin/env bash
set -euo pipefail

# Local qualification of the bounded native cleanup binaries, replacing the
# archived bounded-validation workflow. Each platform runs the workflow's steps
# on a fresh `git archive` of HEAD, so the binaries, their acceptance proofs
# and source.sha256 all come from one committed native source.
#
#   linux-x64                 build and qualify on this Linux x64 machine
#   darwin-arm64 <ssh-host>   send HEAD to an Apple silicon Mac, qualify there
#                             in a detached tmux session, copy the result back
#   assemble                  combine both platform results into
#                             lance-maintenance/artifacts and verify them with
#                             prepare-bounded-runtime.cjs --required
#   all <ssh-host>            both platforms at once, then assemble
#   platform <out-dir>        the per-machine steps, run inside an exported tree
#
# The steps always come from this copy of the script, so an older commit can
# be qualified with the current route.
#
# Results go to $GMAX_QUALIFY_DIR/runs/<native source digest> (default
# ~/.cache/gmax-bounded-qualify); the cargo target and Python environment stay
# in $GMAX_QUALIFY_DIR and are reused by later releases. Requirements on each
# machine: rustup, protoc, uv with Python 3.13, node, and on Linux udisksctl
# (the small ext4 fixture volume is mounted through udisks, without root) and
# on macOS hdiutil and tmux.

TOOLCHAIN=1.98.0
PYTHON_VERSION=3.13
# The native engine is Lance 12, and the acceptance harness reads its stores
# with an independent pylance 12.0.0 (tests/python/test_bounded_cleanup_acceptance.py:23).
# lance-maintenance itself has moved to a newer pylance, so the fixture runtime
# is the lance-maintenance lock of v0.26.108, the last one on 12.0.0. Move this
# with the engine.
FIXTURE_LOCK_COMMIT=2ebdb621bda25ada7b400d968700544dbea7b853
FIXTURE_SIZE=192M
MIN_FREE_GIB=20
CARGO_AUDIT_VERSION=0.22.2
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${GMAX_QUALIFY_DIR:-$HOME/.cache/gmax-bounded-qualify}"

say() { printf 'qualify-bounded-native: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }
usage() {
  echo "Usage: bash scripts/qualify-bounded-native.sh linux-x64 | darwin-arm64 <ssh-host> | assemble | all <ssh-host> | platform <out-dir>" >&2
  exit 2
}

# The committed source every platform builds. Uncommitted native edits would
# make the binaries disagree with the digest assemble computes from this tree.
source_commit() {
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$ROOT is not a git checkout"
  if [ -n "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all -- lance-maintenance/native)" ]; then
    fail "lance-maintenance/native has uncommitted changes; commit them first"
  fi
  git -C "$ROOT" rev-parse HEAD
}

# Runs are keyed by the native source digest, so commits that leave the native
# source alone share one run and assemble finds it after HEAD moves on.
run_dir() {
  printf '%s/runs/%s\n' "$CACHE" "$(node "$ROOT/scripts/bounded-source-digest.cjs" "$ROOT/lance-maintenance/native")"
}

check_host() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || fail "invalid ssh host: $1"
}

# ---------------------------------------------------------------------------
# platform: the workflow's steps on this machine, in an exported source tree.

platform_name() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo linux-x64 ;;
    Darwin-arm64) echo darwin-arm64 ;;
    *) fail "unsupported machine $(uname -s)-$(uname -m)" ;;
  esac
}

FIXTURE_DEVICE=""
FIXTURE_MOUNT=""
FIXTURE_IMAGE=""
cleanup_fixture() {
  if [ -n "$FIXTURE_DEVICE" ]; then
    udisksctl unmount --no-user-interaction -b "$FIXTURE_DEVICE" >/dev/null 2>&1 || true
    # udisks sets autoclear, so unmounting releases the loop device.
    if [ -e "/sys/block/${FIXTURE_DEVICE#/dev/}/loop" ]; then
      udisksctl loop-delete --no-user-interaction -b "$FIXTURE_DEVICE" >/dev/null 2>&1 ||
        say "loop device $FIXTURE_DEVICE is still attached"
    fi
  elif [ -n "$FIXTURE_MOUNT" ]; then
    hdiutil detach "$FIXTURE_MOUNT" >/dev/null 2>&1 || hdiutil detach -force "$FIXTURE_MOUNT" >/dev/null 2>&1 ||
      say "fixture volume at $FIXTURE_MOUNT is still attached"
  fi
  [ -z "$FIXTURE_IMAGE" ] || rm -f "$FIXTURE_IMAGE"
}

# Two acceptance cases fill a small task-owned volume; without one they skip
# and the verdict fails, so a missing volume stops the run here instead.
mount_fixture() {
  local work=$1 platform=$2
  if [ "$platform" = darwin-arm64 ]; then
    FIXTURE_IMAGE="$work/fixture.sparseimage"
    hdiutil create -quiet -size "$FIXTURE_SIZE" -type SPARSE -fs APFS -volname GmaxBoundedFixture "$FIXTURE_IMAGE"
    mkdir -p "$work/fixture"
    FIXTURE_MOUNT="$work/fixture"
    hdiutil attach -quiet -nobrowse -mountpoint "$FIXTURE_MOUNT" "$FIXTURE_IMAGE"
  else
    FIXTURE_IMAGE="$work/fixture.img"
    truncate -s "$FIXTURE_SIZE" "$FIXTURE_IMAGE"
    mkfs.ext4 -q -F -E "root_owner=$(id -u):$(id -g)" "$FIXTURE_IMAGE"
    local mapped
    mapped=$(udisksctl loop-setup --no-user-interaction -f "$FIXTURE_IMAGE")
    FIXTURE_DEVICE=$(printf '%s\n' "$mapped" | sed -n 's/^Mapped file .* as \(\/dev\/loop[0-9]*\)\.$/\1/p')
    [ -n "$FIXTURE_DEVICE" ] || fail "udisksctl loop-setup gave no device: $mapped"
    # udisks may mount the new device on its own; mount it only if it has not.
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      FIXTURE_MOUNT=$(findmnt -n -o TARGET "$FIXTURE_DEVICE" || true)
      [ -n "$FIXTURE_MOUNT" ] && break
      udisksctl mount --no-user-interaction -b "$FIXTURE_DEVICE" >/dev/null 2>&1 || sleep 1
    done
    [ -n "$FIXTURE_MOUNT" ] || fail "could not mount the fixture volume $FIXTURE_DEVICE"
  fi
  [ -w "$FIXTURE_MOUNT" ] || fail "fixture volume $FIXTURE_MOUNT is not writable"
  say "fixture volume $FIXTURE_MOUNT"
}

platform_run() {
  local out=$1
  local platform work target binary python rustup manifest=lance-maintenance/native/Cargo.toml
  [ -f "$manifest" ] && [ -f scripts/bounded-source-digest.cjs ] || fail "run platform from the root of an exported gmax tree"
  [ ! -d .git ] || fail "platform runs on an exported tree, not a checkout"
  platform=$(platform_name)
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  work=$(cd "$out/.." && pwd)
  export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/sbin:/sbin"
  rustup=$(command -v rustup) || fail "rustup is required (https://rustup.rs)"
  command -v protoc >/dev/null || fail "protoc is required"
  command -v uv >/dev/null || fail "uv is required"
  command -v node >/dev/null || fail "node is required"

  mkdir -p "$CACHE"
  local free_kib
  free_kib=$(df -Pk "$CACHE" | awk 'NR == 2 {print $4}')
  [ "${free_kib:-0}" -ge $((MIN_FREE_GIB * 1024 * 1024)) ] || fail "under ${MIN_FREE_GIB} GiB free for the cargo target"

  "$rustup" toolchain install "$TOOLCHAIN" --profile minimal
  cargo() { "$rustup" run "$TOOLCHAIN" cargo "$@"; }
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" CARGO_INCREMENTAL=0
  export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0
  export CARGO_TARGET_DIR="$CACHE/target-$platform"
  target="$CARGO_TARGET_DIR/release"
  binary="$target/gmax-bounded-maintenance"

  [ -f .fixture-python/uv.lock ] || fail "the exported tree has no .fixture-python lock"
  python=$(uv python find --no-python-downloads "$PYTHON_VERSION") || fail "Python $PYTHON_VERSION is required (uv python install $PYTHON_VERSION)"
  export UV_PROJECT_ENVIRONMENT="$CACHE/python-$platform-lance12"
  uv sync --locked --project .fixture-python --no-dev --no-build --no-python-downloads --python "$python"
  local env_python="$UV_PROJECT_ENVIRONMENT/bin/python"

  trap cleanup_fixture EXIT
  mount_fixture "$work" "$platform"
  export GMAX_BOUNDED_FIXTURE_BASE="$FIXTURE_MOUNT"

  say "cargo test (engine, qualification)"
  cargo test --profile release --locked --manifest-path "$manifest" --features engine,qualification --no-fail-fast
  say "build qualification executable"
  cargo build --profile release --locked --manifest-path "$manifest" --features engine,qualification
  say "fault acceptance"
  GMAX_BOUNDED_NATIVE_EXECUTABLE="$binary" GMAX_BOUNDED_FAULT_EVIDENCE="$out/fault-acceptance.json" \
    "$env_python" -I tests/native/bounded_native_fault_acceptance.py
  say "build shipping executable"
  cargo build --profile release --locked --manifest-path "$manifest" --features engine
  cp "$binary" "$out/gmax-bounded-maintenance"
  "$binary" --capabilities > "$out/capabilities.json"
  echo release > "$out/build-profile.txt"
  node scripts/bounded-source-digest.cjs lance-maintenance/native > "$out/source.sha256"
  say "shipping acceptance"
  GMAX_BOUNDED_NATIVE_EXECUTABLE="$binary" GMAX_BOUNDED_EVIDENCE="$out/acceptance.json" \
    "$env_python" -I tests/python/test_bounded_native_acceptance.py

  say "dependency notices"
  local host
  host=$("$rustup" run "$TOOLCHAIN" rustc -vV | sed -n 's/^host: //p')
  cargo metadata --locked --format-version 1 --manifest-path "$manifest" --features engine \
    --filter-platform "$host" > "$work/native-metadata-$platform.json"
  "$env_python" -I scripts/bounded-native-notices.py "$work/native-metadata-$platform.json" "$out/THIRD-PARTY-NOTICES.txt"

  if [ "$platform" = linux-x64 ]; then
    say "dependency advisories"
    if [ "$("$CACHE/cargo-audit/bin/cargo-audit" --version 2>/dev/null)" != "cargo-audit $CARGO_AUDIT_VERSION" ]; then
      cargo install cargo-audit --locked --version "$CARGO_AUDIT_VERSION" --root "$CACHE/cargo-audit"
    fi
    "$CACHE/cargo-audit/bin/cargo-audit" audit --file lance-maintenance/native/Cargo.lock
  fi
  say "qualified $platform from source $(cat "$out/source.sha256") in $out"
}

# ---------------------------------------------------------------------------
# Orchestration from a checkout.

export_source() {
  local commit=$1 dest=$2
  rm -rf "$dest"
  mkdir -p "$dest"
  git -C "$ROOT" archive "$commit" | tar -x -C "$dest"
  mkdir "$dest/.fixture-python"
  git -C "$ROOT" archive "$FIXTURE_LOCK_COMMIT" lance-maintenance/pyproject.toml lance-maintenance/uv.lock |
    tar -x -C "$dest/.fixture-python" --strip-components=1
}

run_linux() {
  local commit dir
  commit=$(source_commit)
  [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "linux-x64 runs on a Linux x64 machine"
  dir=$(run_dir)
  export_source "$commit" "$dir/src-linux-x64"
  rm -rf "$dir/bounded-native-linux-x64"
  say "linux-x64 from $commit in $dir"
  (cd "$dir/src-linux-x64" && GMAX_QUALIFY_DIR="$CACHE" nice -n 10 bash "$ROOT/scripts/qualify-bounded-native.sh" platform "$dir/bounded-native-linux-x64")
}

# The Mac runs in a detached tmux session with a log and an exit file, so a
# dropped connection never stops a long compile; rerunning follows it again.
REMOTE_SCRIPT='set -u
key=$1 session=$2
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
dir="$HOME/.cache/gmax-bounded-qualify/runs/$key"
case "$3" in
  receive)
    if tmux has-session -t "=$session" 2>/dev/null; then cat >/dev/null; exit 0; fi
    rm -rf "$dir/src-darwin-arm64" "$dir/bounded-native-darwin-arm64" "$dir/fixture" "$dir/fixture.sparseimage" "$dir/exit"
    mkdir -p "$dir/src-darwin-arm64" && tar -x -C "$dir/src-darwin-arm64" ;;
  run)
    if ! tmux has-session -t "=$session" 2>/dev/null; then
      [ -d "$dir/src-darwin-arm64" ] || { echo "no source at $dir/src-darwin-arm64" >&2; exit 1; }
      : > "$dir/log"; rm -f "$dir/exit"
      tmux new-session -d -s "$session" "cd \"$dir/src-darwin-arm64\" && nice -n 10 bash \"$dir/qualify-bounded-native.sh\" platform \"$dir/bounded-native-darwin-arm64\" >> \"$dir/log\" 2>&1; echo \$? > \"$dir/exit\"" ||
        { echo "could not start tmux session $session" >&2; exit 1; }
      echo "started tmux session $session on $(hostname -s); log $dir/log" >&2
    else
      echo "following tmux session $session on $(hostname -s); log $dir/log" >&2
    fi
    tail -n +1 -f "$dir/log" & t=$!
    while [ ! -s "$dir/exit" ] && tmux has-session -t "=$session" 2>/dev/null; do sleep 2; done
    sleep 1; kill "$t" 2>/dev/null; wait "$t" 2>/dev/null
    [ -s "$dir/exit" ] || { echo "tmux session $session ended without an exit code; log $dir/log" >&2; exit 125; }
    exit "$(cat "$dir/exit")" ;;
  script)
    if tmux has-session -t "=$session" 2>/dev/null; then cat >/dev/null; exit 0; fi
    cat > "$dir/qualify-bounded-native.sh" ;;
  fetch)
    COPYFILE_DISABLE=1 tar -c -C "$dir" bounded-native-darwin-arm64 ;;
esac'

SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

remote() {
  local host=$1 key=$2 action=$3
  local quoted
  printf -v quoted '%q' "$REMOTE_SCRIPT"
  ssh "${SSH_OPTIONS[@]}" "$host" "/bin/bash -c $quoted qualify $key gmax-qualify-${key:0:12} $action"
}

run_darwin() {
  local host=$1 commit dir key
  check_host "$host"
  commit=$(source_commit)
  dir=$(run_dir)
  key=$(basename "$dir")
  say "darwin-arm64 from $commit on $host"
  export_source "$commit" "$dir/src-darwin-arm64"
  tar -c -C "$dir/src-darwin-arm64" . | remote "$host" "$key" receive
  remote "$host" "$key" script < "$ROOT/scripts/qualify-bounded-native.sh"
  remote "$host" "$key" run
  mkdir -p "$dir"
  rm -rf "$dir/bounded-native-darwin-arm64"
  remote "$host" "$key" fetch | tar -x -C "$dir"
  say "copied darwin-arm64 result to $dir/bounded-native-darwin-arm64"
}

run_assemble() {
  local dir check
  source_commit >/dev/null
  dir=$(run_dir)
  node "$ROOT/scripts/assemble-bounded-runtime.cjs" "$dir" "$ROOT/lance-maintenance/artifacts"
  check=$(mktemp -d)
  node "$ROOT/scripts/prepare-bounded-runtime.cjs" "$ROOT/lance-maintenance/artifacts" "$check" --required
  rm -rf "$check"
  say "lance-maintenance/artifacts accepted by prepare-bounded-runtime.cjs --required"
  (cd "$ROOT/lance-maintenance/artifacts" && shasum -a 256 manifest.json acceptance.json THIRD-PARTY-NOTICES.txt \
    gmax-bounded-maintenance-linux-x64 gmax-bounded-maintenance-darwin-arm64)
}

run_all() {
  local host=$1 darwin status=0
  check_host "$host"
  source_commit >/dev/null
  run_darwin "$host" & darwin=$!
  run_linux || status=$?
  wait "$darwin" || status=$?
  [ "$status" -eq 0 ] || fail "a platform failed; see the output above"
  run_assemble
}

case "${1:-}" in
  platform) [ $# -eq 2 ] || usage; platform_run "$2" ;;
  linux-x64) [ $# -eq 1 ] || usage; run_linux ;;
  darwin-arm64) [ $# -eq 2 ] || usage; run_darwin "$2" ;;
  assemble) [ $# -eq 1 ] || usage; run_assemble ;;
  all) [ $# -eq 2 ] || usage; run_all "$2" ;;
  *) usage ;;
esac

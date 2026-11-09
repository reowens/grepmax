const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "qualify-bounded-native.sh");

function run(args, options = {}) {
  return spawnSync("bash", [options.script ?? script, ...args], {
    cwd: options.cwd ?? path.dirname(script), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ...options.env },
  });
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// A throwaway checkout holding just enough for the source checks.
function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-qualify-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "lance-maintenance/native/src"), { recursive: true });
  fs.copyFileSync(script, path.join(root, "scripts/qualify-bounded-native.sh"));
  fs.writeFileSync(path.join(root, "scripts/bounded-source-digest.cjs"), "");
  fs.writeFileSync(path.join(root, "lance-maintenance/native/Cargo.toml"), "[package]\n");
  fs.writeFileSync(path.join(root, "lance-maintenance/native/src/main.rs"), "fn main() {}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  return { root, script: path.join(root, "scripts/qualify-bounded-native.sh"), cache: path.join(root, "cache") };
}

test("the script and its remote steps parse", () => {
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const remote = fs.readFileSync(script, "utf8").match(/^REMOTE_SCRIPT='([\s\S]*?\nesac)'$/m);
  assert.ok(remote, "REMOTE_SCRIPT block not found");
  assert.equal(spawnSync("bash", ["-n"], { input: remote[1] }).status, 0);
});

test("unknown commands and wrong argument counts print usage", () => {
  for (const args of [[], ["release"], ["linux-x64", "extra"], ["darwin-arm64"], ["all"], ["platform"], ["assemble", "x"]]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^Usage: /);
  }
});

test("an ssh host with shell characters is refused", () => {
  for (const host of ["bad host", "-oProxyCommand=x", "a;b", "$(x)"]) {
    const result = run(["darwin-arm64", host]);
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, /invalid ssh host/);
  }
});

test("uncommitted or untracked native source stops every route before any work", (t) => {
  const repo = checkout(t);
  const native = path.join(repo.root, "lance-maintenance/native");
  for (const change of [
    () => fs.appendFileSync(path.join(native, "Cargo.toml"), "# edit\n"),
    () => fs.writeFileSync(path.join(native, "src/extra.rs"), ""),
  ]) {
    fs.writeFileSync(path.join(native, "Cargo.toml"), "[package]\n");
    fs.rmSync(path.join(native, "src/extra.rs"), { force: true });
    change();
    for (const args of [["linux-x64"], ["darwin-arm64", "mac"], ["assemble"], ["all", "mac"]]) {
      const result = run(args, { script: repo.script, cwd: repo.root, env: { GMAX_QUALIFY_DIR: repo.cache } });
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /lance-maintenance\/native has uncommitted changes/);
    }
  }
  assert.equal(fs.existsSync(repo.cache), false);
});

test("platform refuses to build inside a checkout", (t) => {
  const repo = checkout(t);
  const result = run(["platform", path.join(repo.root, "out")], { script: repo.script, cwd: repo.root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exported tree, not a checkout/);
  assert.equal(fs.existsSync(path.join(repo.root, "out")), false);
});

test("the fixture lock commit pins the pylance the acceptance harness requires", () => {
  const commit = fs.readFileSync(script, "utf8").match(/^FIXTURE_LOCK_COMMIT=([0-9a-f]{40})$/m);
  assert.ok(commit, "FIXTURE_LOCK_COMMIT not found");
  const root = path.dirname(__dirname);
  const show = (file) => spawnSync("git", ["-C", root, "show", `${commit[1]}:${file}`], { encoding: "utf8" });
  const project = show("lance-maintenance/pyproject.toml");
  assert.equal(project.status, 0, project.stderr);
  const required = fs.readFileSync(path.join(root, "tests/python/test_bounded_cleanup_acceptance.py"), "utf8")
    .match(/version\('pylance'\) == '([0-9.]+)'/);
  assert.ok(required, "harness pylance requirement not found");
  assert.match(project.stdout, new RegExp(`"pylance==${required[1].replaceAll(".", "\\.")}"`));
  assert.match(show("lance-maintenance/uv.lock").stdout, new RegExp(`name = "pylance"\\nversion = "${required[1].replaceAll(".", "\\.")}"`));
});

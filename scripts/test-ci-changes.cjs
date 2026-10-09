const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const script = path.join(__dirname, "ci-changes.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-ci-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const commit = () => {
    git("add", "--force", "--all");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  write("README.md", "baseline\n");
  write("src/code.ts", "baseline\n");
  const base = commit();
  function check(eventName = "push", event = { before: base }, cwd = root) {
    const eventFile = path.join(root, ".git", "event.json");
    const outputFile = path.join(root, ".git", "output");
    fs.writeFileSync(eventFile, JSON.stringify(event));
    fs.writeFileSync(outputFile, "");
    const run = spawnSync(process.execPath, [script], {
      cwd, encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(fs.readFileSync(outputFile, "utf8"), `run_checks=${result.runChecks}\n`);
    return result;
  }
  return { root, git, write, commit, check, base };
}

test("Markdown-only push skips expensive jobs across the complete commit range", t => {
  const f = fixture(t);
  f.write("README.md", "updated\n");
  f.commit();
  f.write("docs/with spaces\nand newline.md", "documentation\n");
  f.commit();
  assert.equal(f.check().runChecks, false);
});

test("source mixed with docs still runs full checks", t => {
  const f = fixture(t);
  f.write("README.md", "updated\n");
  f.write("src/code.ts", "changed\n");
  f.commit();
  assert.equal(f.check().runChecks, true);
});

test("source renamed into docs cannot bypass checks", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "docs"));
  f.git("mv", "src/code.ts", "docs/code.md");
  f.commit();
  assert.equal(f.check().runChecks, true);
});

test("configuration and Markdown fixtures outside docs still run checks", t => {
  const f = fixture(t);
  f.write("tests/fixtures/input.md", "fixture\n");
  f.write(".github/workflows/ci.yml", "configuration\n");
  f.commit();
  assert.equal(f.check().runChecks, true);
});

test("pull-request comparison uses its base commit", t => {
  const f = fixture(t);
  f.write("docs/notes.md", "documentation\n");
  f.commit();
  assert.equal(f.check("pull_request", { pull_request: { base: { sha: f.base } } }).runChecks, false);
});

test("manual dispatch always runs full checks", t => {
  const f = fixture(t);
  f.write("docs/notes.md", "documentation\n");
  f.commit();
  assert.equal(f.check("workflow_dispatch").runChecks, true);
});

test("empty diff, new branch and malformed base all run checks", t => {
  const f = fixture(t);
  assert.equal(f.check().runChecks, true);
  assert.equal(f.check("push", { before: "0".repeat(40) }).runChecks, true);
  assert.equal(f.check("push", { before: "HEAD; exit 0" }).runChecks, true);
});

test("unavailable history cannot silently skip checks", t => {
  const f = fixture(t);
  assert.equal(f.check("push", { before: "f".repeat(40) }).runChecks, true);
});

test("shallow checkout fetches the exact comparison base before skipping docs", t => {
  const f = fixture(t);
  f.write("docs/notes.md", "documentation\n");
  f.commit();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-ci-shallow-"));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync("git", ["clone", "--quiet", "--depth=1", `file://${f.root}`, clone]);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${f.base}^{commit}`], { cwd: clone }).status, 0);
  assert.equal(f.check("push", { before: f.base }, clone).runChecks, false);
});

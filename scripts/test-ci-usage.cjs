const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pages, runsInWindow, runner, normalize, totals, report, collect, argumentsFor, privateOutput } = require("./ci-usage.cjs");
const at = "2026-10-01T00:00:00Z";
const now = new Date("2026-10-09T00:00:00Z");
const from = Date.parse(at) / 1000;
const run = { id: 1, name: "CI", run_attempt: 2, status: "completed", event: "push", head_sha: "abc",
  created_at: at, updated_at: "2026-10-01T00:03:00Z" };
const job = { id: 11, name: "build", run_attempt: 1, status: "completed", conclusion: "success",
  started_at: at, completed_at: "2026-10-01T00:01:00Z", labels: ["ubuntu-latest"], runner_name: "GitHub Actions 1" };
const record = (attempt, jobs) => ({ repository: "owner/repo", run, attempt, jobs });

test("job pagination follows total_count and rejects missing pages", async () => {
  const items = Array.from({ length: 101 }, (_, id) => ({ id }));
  const result = await pages(async endpoint => ({ total_count: 101,
    jobs: endpoint.endsWith("page=1") ? items.slice(0, 100) : items.slice(100) }), "jobs", "jobs");
  assert.equal(result.length, 101);
  await assert.rejects(pages(async () => ({ total_count: 2, jobs: [] }), "jobs", "jobs"), /Incomplete/);
});

test("organization pagination covers full pages without total_count", async () => {
  let calls = 0;
  const result = await pages(async () => ++calls === 1 ? Array(100).fill({}) : [{}], "orgs/o/repos", null);
  assert.equal(result.length, 101);
  assert.equal(calls, 2);
});

test("run search partitions capped queries, deduplicates IDs, and uses exclusive end", async () => {
  const queries = [];
  const api = async endpoint => {
    const query = new URL("https://api.github.com/" + endpoint).searchParams;
    const created = query.get("created");
    queries.push(created);
    const [low, high] = created.split("..").map(value => Date.parse(value) / 1000);
    if (high - low > 1) return { total_count: 1000, workflow_runs: [] };
    return { total_count: 2, workflow_runs: [{ ...run, id: low, created_at: new Date(low * 1000).toISOString() },
      { ...run, id: 99, created_at: new Date(from * 1000).toISOString() }] };
  };
  const result = await runsInWindow(api, "o/r", from, from + 4);
  assert.equal(queries.length, 3);
  assert.equal(result.length, 3);
  assert.ok(queries[0].endsWith("2026-10-01T00:00:03Z"));
  await assert.rejects(runsInWindow(async () => ({ total_count: 1000, workflow_runs: [] }), "o/r", from, from + 1), /one second/);
});

test("run pagination retrieves all pages", async () => {
  const result = await runsInWindow(async endpoint => {
    const page = new URL("https://api.github.com/" + endpoint).searchParams.get("page");
    return { total_count: 101, workflow_runs: page === "1"
      ? Array.from({ length: 100 }, (_, id) => ({ ...run, id })) : [{ ...run, id: 100 }] };
  }, "o/r", from, from + 5);
  assert.equal(result.length, 101);
});

test("partial reruns carry forward successful jobs without counting them twice", () => {
  const jobs = normalize([record(1, [job, { ...job, id: 12, conclusion: "failure" }]),
    record(2, [job, { ...job, id: 13, run_attempt: 2 }])], now.toISOString());
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0].observed_attempts, [1, 2]);
  assert.equal(totals(jobs).seconds, 180);
  assert.equal(totals(jobs).unsuccessful_seconds, 60);
  assert.equal(jobs[0].seconds_before_job_start, 0);
});

test("GitHub copied successes with NEW IDs preserve aliases but count execution once", () => {
  const success = { ...job, steps: [{ name: "Set up job", number: 1, started_at: at, completed_at: job.completed_at }] };
  const jobs = normalize([record(1, [success]), record(2, [{ ...success, id: 22, run_attempt: 2 },
    { ...success, id: 23, run_attempt: 2, started_at: "2026-10-01T00:02:00Z", completed_at: "2026-10-01T00:03:00Z" }])], now.toISOString());
  assert.equal(jobs.length, 3);
  assert.equal(jobs[1].duration_state, "carried_forward");
  assert.equal(jobs[1].actual_execution_job_id, 11);
  assert.equal(totals(jobs).seconds, 120);
  assert.equal(totals(jobs).carried_forward, 1);
});

test("skipped, active, queued, missing and invalid timestamps stay distinct", () => {
  const jobs = normalize([record(1, [
    { ...job, id: 1, conclusion: "skipped", started_at: null, completed_at: null },
    { ...job, id: 2, status: "in_progress", conclusion: null, completed_at: null },
    { ...job, id: 3, completed_at: null },
    { ...job, id: 4, completed_at: "2026-09-30T00:00:00Z" },
    { ...job, id: 5, status: "queued", started_at: null, completed_at: null },
  ])], "2026-10-01T00:02:00Z");
  assert.deepEqual(jobs.map(item => item.duration_state), ["skipped", "provisional", "missing", "missing", "provisional"]);
  assert.equal(jobs[1].provisional_seconds, 120);
  assert.equal(jobs[4].provisional_seconds, null);
  assert.equal(totals(jobs).seconds, 0);
  assert.equal(totals(jobs).missing, 2);
});

test("runner classification uses labels and proven runner metadata, never job names", () => {
  assert.deepEqual(runner(["macos-15"], "GitHub Actions 123"), { os: "macOS", provider: "GitHub-hosted" });
  assert.deepEqual(runner(["self-hosted", "Linux", "ARM64"]), { os: "Linux", provider: "self-hosted" });
  assert.deepEqual(runner(["depot-ubuntu-24.04"]), { os: "unknown", provider: "Depot" });
  assert.deepEqual(runner(["custom"]), { os: "unknown", provider: "unknown" });
  assert.deepEqual(runner(["ubuntu-latest"]), { os: "Linux", provider: "unknown" });
});

test("cancelled timestamp spans without assigned runners are not execution minutes", () => {
  const jobs = normalize([record(1, [{ ...job, runner_name: "", runner_id: 0,
    conclusion: "cancelled", completed_at: "2026-10-02T00:00:00Z" }])], now.toISOString());
  assert.equal(jobs[0].duration_state, "unverified");
  assert.equal(totals(jobs).seconds, 0);
  assert.equal(totals(jobs).unverified_span_seconds, 86400);
});

test("collection caches completed attempts, refreshes changed reruns and reports unavailable repos", async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ci-usage-test-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  let requests = 0;
  let latestRun = run;
  const api = async endpoint => {
    requests++;
    if (endpoint.includes("missing/repo")) throw new Error("HTTP 404: unavailable");
    if (endpoint.startsWith("orgs/")) return [{ full_name: "owner/repo" }];
    if (endpoint.includes("/jobs?")) return { total_count: 1, jobs: [job] };
    return { total_count: 1, workflow_runs: [latestRun] };
  };
  const options = { api, output, repositories: ["owner/repo", "missing/repo"], organizations: ["owner"],
    groups: { Product: ["owner/repo", "owner/repo"] }, from, to: from + 86400, now };
  const first = await collect(options);
  assert.equal(first.jobs.length, 1);
  assert.equal(first.repositories[1].run_count, null);
  assert.match(report(first), /UNAVAILABLE: HTTP 404/);
  assert.match(report(first), /not been collected/);
  const firstRequests = requests;
  requests = 0;
  const second = await collect(options);
  assert.deepEqual(second.jobs, first.jobs);
  assert.equal(second.cached_attempts, 2);
  assert.ok(requests < firstRequests);
  latestRun = { ...run, run_attempt: 3, updated_at: "2026-10-08T23:00:00Z" };
  const third = await collect(options);
  assert.equal(third.cached_attempts, 0);
  assert.equal(third.jobs.length, 1);
  const mode = (await fs.stat(path.join(output, "raw.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  const grouped = await fs.readFile(path.join(output, "group-product.md"), "utf8");
  assert.match(grouped, /1 unique job records/);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, "runs.json")))[0].repository, "owner/repo");
});

test("active attempts refresh and failures remain coverage gaps rather than cached zero", async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ci-usage-active-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  let fail = true, calls = 0;
  const api = async endpoint => {
    if (endpoint.includes("/jobs?")) {
      calls++;
      if (fail) throw new Error("jobs unavailable");
      return { total_count: 1, jobs: [{ ...job, status: "in_progress", completed_at: null }] };
    }
    return { total_count: 1, workflow_runs: [{ ...run, run_attempt: 1, status: "in_progress" }] };
  };
  const options = { api, output, repositories: ["owner/repo"], from, to: from + 86400, now };
  assert.equal((await collect(options)).repositories[0].errors.length, 1);
  fail = false;
  assert.equal((await collect(options)).jobs[0].duration_state, "provisional");
  assert.equal((await collect(options)).cached_attempts, 0);
  assert.equal(calls, 3);
});

test("organization discovery failure stays visible", async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ci-usage-org-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const data = await collect({ api: async () => { throw new Error("denied"); }, output,
    repositories: [], organizations: ["private"], from, to: from + 1, now });
  assert.match(report(data), /discovery gaps: private: denied/);
});

test("CLI validates explicit scope, UTC bounds and private destination", async () => {
  assert.equal(argumentsFor(["--repo", "o/r", "--output", "/tmp/private"], now).to, now.getTime() / 1000);
  assert.throws(() => argumentsFor(["--repo", "o/r"], now), /Require/);
  assert.throws(() => argumentsFor(["--repo", "o/r", "--output", "/tmp/x", "--from", "tomorrow"], now), /Invalid/);
  await assert.rejects(privateOutput(path.resolve(__dirname, "../private-output")), /outside/);
});

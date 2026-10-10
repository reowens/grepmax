// Read-only, on-demand GitHub Actions accounting. Requires Node 22 and authenticated gh.
// Elapsed job seconds are observations, never provider billable minutes or charges.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const execute = promisify(execFile);
const iso = seconds => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const stamp = value => value ? Date.parse(value) : NaN;
const seconds = (start, end) => Number.isFinite(stamp(start)) && stamp(end) >= stamp(start)
  ? (stamp(end) - stamp(start)) / 1000 : null;
const escape = value => String(value ?? "unknown").replace(/[|\r\n]/g, " ");

async function github(endpoint) {
  const { stdout } = await execute("gh", ["api", endpoint, "-H", "Accept: application/vnd.github+json"],
    { maxBuffer: 32 * 1024 * 1024, timeout: 45000 });
  return JSON.parse(stdout);
}

async function pages(api, endpoint, key) {
  const result = [];
  for (let page = 1; ; page++) {
    const body = await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = key ? body[key] : body;
    if (!Array.isArray(items)) throw new Error(`Invalid paginated response: ${endpoint}`);
    result.push(...items);
    if (key && Number.isInteger(body.total_count)) {
      if (result.length >= body.total_count) break;
      if (!items.length) throw new Error(`Incomplete pagination: ${endpoint}`);
    } else if (items.length < 100) break;
  }
  return result;
}

// GitHub caps filtered run searches at 1,000. Disjoint whole-second windows avoid
// overlap; job identity deduplication also protects against concurrent API changes.
async function runsInWindow(api, repo, from, to) {
  const runs = new Map();
  async function window(low, high) {
    const endpoint = `repos/${repo}/actions/runs?created=${encodeURIComponent(`${iso(low)}..${iso(high)}`)}`;
    const first = await api(`${endpoint}&per_page=100&page=1`);
    if (!Array.isArray(first.workflow_runs) || !Number.isInteger(first.total_count))
      throw new Error(`Invalid run response: ${repo}`);
    if (first.total_count >= 1000) {
      if (low === high) throw new Error(`Search cap reached within one second: ${repo} ${iso(low)}`);
      const mid = Math.floor((low + high) / 2);
      await window(low, mid);
      await window(mid + 1, high);
      return;
    }
    let count = first.workflow_runs.length;
    for (const run of first.workflow_runs) runs.set(run.id, run);
    for (let page = 2; count < first.total_count; page++) {
      const body = await api(`${endpoint}&per_page=100&page=${page}`);
      if (!Array.isArray(body.workflow_runs) || !body.workflow_runs.length)
        throw new Error(`Incomplete run pagination: ${repo}`);
      count += body.workflow_runs.length;
      for (const run of body.workflow_runs) runs.set(run.id, run);
    }
  }
  await window(from, to - 1);
  return [...runs.values()].filter(run => stamp(run.created_at) >= from * 1000 && stamp(run.created_at) < to * 1000);
}

function runner(labels = [], runnerName = "") {
  const normalized = labels.map(label => label.toLowerCase());
  const os = normalized.some(label => /^(macos|macosx|osx)(-|$)/.test(label)) ? "macOS"
    : normalized.some(label => /^(ubuntu|linux)(-|$)/.test(label)) ? "Linux"
    : normalized.some(label => /^windows(-|$)/.test(label)) ? "Windows" : "unknown";
  const provider = normalized.some(label => /^depot(?:-|\/|$)/.test(label)) ? "Depot"
    : normalized.includes("self-hosted") ? "self-hosted"
    : /^GitHub Actions /.test(runnerName) ? "GitHub-hosted" : "unknown";
  return { os, provider };
}

function normalize(records, asOf) {
  const jobs = new Map();
  for (const { repository, run, attempt, jobs: rawJobs } of records) {
    for (const raw of rawJobs) {
      const identity = `${repository.toLowerCase()}/${raw.id}`;
      const previous = jobs.get(identity);
      const skipped = raw.conclusion === "skipped";
      const span = seconds(raw.started_at, raw.completed_at);
      const assigned = Number(raw.runner_id) > 0 || Boolean(raw.runner_name);
      const elapsed = skipped ? 0 : raw.status === "completed" && assigned ? span : null;
      const item = {
        repository, job_id: raw.id, run_id: run.id, run_attempt: raw.run_attempt ?? attempt,
        observed_attempts: [...new Set([...(previous?.observed_attempts ?? []), attempt])].sort((a, b) => a - b),
        workflow: raw.workflow_name ?? run.name, job: raw.name, event: run.event,
        head_sha: raw.head_sha ?? run.head_sha, run_created_at: run.created_at,
        started_at: raw.started_at, completed_at: raw.completed_at,
        status: raw.status, conclusion: raw.conclusion, labels: raw.labels ?? [],
        runner_name: raw.runner_name, runner_id: raw.runner_id,
        runner_group_name: raw.runner_group_name, ...runner(raw.labels, raw.runner_name),
        step_timing_digest: raw.steps?.length ? createHash("sha256").update(JSON.stringify(raw.steps.map(step =>
          [step.number, step.name, step.status, step.conclusion, step.started_at, step.completed_at]))).digest("hex") : null,
        duration_seconds: elapsed,
        duration_state: skipped ? "skipped" : raw.status !== "completed" ? "provisional"
          : span === null ? "missing" : !assigned ? "unverified" : "measured",
        timestamp_span_seconds: span,
        provisional_seconds: raw.status === "in_progress" && assigned ? seconds(raw.started_at, asOf) : null,
        seconds_before_job_start: skipped ? null : seconds(run.created_at, raw.started_at),
        url: raw.html_url,
      };
      // A carry-forward job may occur in several attempt responses. Prefer its
      // terminal observation; count its actual execution once.
      if (previous?.status === "completed" && item.status !== "completed") {
        previous.observed_attempts = item.observed_attempts;
      } else jobs.set(identity, item);
    }
  }
  const normalized = [...jobs.values()].sort((a, b) => a.run_attempt - b.run_attempt || a.job_id - b.job_id);
  const executions = new Map();
  for (const job of normalized) {
    job.actual_execution_job_id = job.job_id;
    if (job.duration_state !== "measured" || job.conclusion !== "success" || !job.step_timing_digest) continue;
    // GitHub also clones carry-forward successes under NEW job IDs. Require an
    // exact execution/step fingerprint across attempts; keep both API records.
    const fingerprint = JSON.stringify([job.repository, job.run_id, job.head_sha, job.job,
      job.started_at, job.completed_at, job.runner_id, job.runner_name, job.step_timing_digest]);
    const original = executions.get(fingerprint);
    if (original && original.run_attempt < job.run_attempt) {
      job.actual_execution_job_id = original.job_id;
      job.duration_state = "carried_forward";
      job.duration_seconds = 0;
    } else executions.set(fingerprint, job);
  }
  return normalized.sort((a, b) => a.repository.localeCompare(b.repository) || a.job_id - b.job_id);
}

function totals(jobs) {
  return jobs.reduce((sum, job) => {
    sum.jobs++;
    sum.seconds += job.duration_seconds ?? 0;
    if (job.duration_state === "unverified") sum.unverified_span_seconds += job.timestamp_span_seconds ?? 0;
    if (["failure", "cancelled", "timed_out", "startup_failure", "action_required"].includes(job.conclusion))
      sum.unsuccessful_seconds += job.duration_seconds ?? 0;
    sum[job.duration_state]++;
    return sum;
  }, { jobs: 0, seconds: 0, unsuccessful_seconds: 0, unverified_span_seconds: 0, measured: 0, skipped: 0, missing: 0, provisional: 0, unverified: 0, carried_forward: 0 });
}

function report(data) {
  const lines = ["# GitHub Actions usage", "",
    `Collected ${data.as_of}. Run-created cohort: **${data.from} ≤ created < ${data.to}**.`, "",
    `Current UTC billing month: **${data.as_of.slice(0, 7)}**. Billing and Depot exports have **not been collected**.`, "",
    "Minutes below are summed elapsed job seconds / 60 where runner assignment is evidenced, without billing rounding or multipliers. They do not establish charges. Active jobs, completed jobs with missing timestamps and timestamp spans without evidenced runner assignment are excluded and listed as gaps. Skipped jobs add no elapsed duration. Carried-forward successes cloned under new IDs retain both records but add duration only once, with their original execution ID. Deleted or API-invisible history cannot be recovered by this collector.", "",
    "## Repository totals", "",
    "| Repository | Runs | Job records | Linux min | Mac min | Windows min | Unknown OS min | Failed/cancelled/etc min | Coverage |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"];
  for (const repo of data.repositories) {
    if (repo.run_count === null) {
      lines.push(`| ${escape(repo.repository)} | unknown | unknown | unknown | unknown | unknown | unknown | unknown | UNAVAILABLE: ${escape(repo.errors.join("; "))} |`);
      continue;
    }
    const jobs = data.jobs.filter(job => job.repository === repo.repository);
    const total = totals(jobs);
    const minutes = os => (totals(jobs.filter(job => job.os === os)).seconds / 60).toFixed(2);
    lines.push(`| ${escape(repo.repository)} | ${repo.run_count ?? "unknown"} | ${total.jobs} | ${minutes("Linux")} | ${minutes("macOS")} | ${minutes("Windows")} | ${minutes("unknown")} | ${(total.unsuccessful_seconds / 60).toFixed(2)} | ${repo.errors.length ? "PARTIAL: " + escape(repo.errors.join("; ")) : "API collection complete"}; ${total.missing} missing, ${total.provisional} provisional, ${total.unverified} unverified, ${total.carried_forward} copied success, ${repo.empty_attempts?.length ?? 0} empty attempts |`);
  }
  for (const [title, repos] of Object.entries(data.groups)) {
    const jobs = data.jobs.filter(job => repos.includes(job.repository));
    const total = totals(jobs);
    const gaps = data.repositories.filter(repo => repos.includes(repo.repository) && repo.errors.length).length;
    lines.push("", `## ${escape(title)}`, "", `${repos.map(escape).join(", ") || "No accessible repositories discovered"}.`, "",
      `${total.jobs} unique job records (${total.carried_forward} copied successes counted once); **${(total.seconds / 60).toFixed(2)} elapsed minutes**, including ${(total.unsuccessful_seconds / 60).toFixed(2)} unsuccessful minutes; ${gaps} repositories with collection gaps. Organization and product rollups overlap: do not add them together.`);
  }
  lines.push("", "## Provider and OS totals", "", "| Provider | OS | Jobs | Elapsed min |", "| --- | --- | ---: | ---: |");
  const bucket = (keyFn, jobs = data.jobs) => {
    const map = new Map();
    for (const job of jobs) {
      const key = keyFn(job);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(job);
    }
    return [...map].map(([key, items]) => ({ key, ...totals(items) })).sort((a, b) => b.seconds - a.seconds);
  };
  for (const row of bucket(job => `${job.provider} | ${job.os}`))
    lines.push(`| ${row.key} | ${row.jobs} | ${(row.seconds / 60).toFixed(2)} |`);
  lines.push("", "## Workflow ranking", "", "| Repository / workflow | Jobs | Elapsed min | Unsuccessful min |", "| --- | ---: | ---: | ---: |");
  for (const row of bucket(job => `${job.repository} / ${job.workflow}`))
    lines.push(`| ${escape(row.key)} | ${row.jobs} | ${(row.seconds / 60).toFixed(2)} | ${(row.unsuccessful_seconds / 60).toFixed(2)} |`);
  lines.push("", "## Job ranking", "", "| Repository / workflow / job / OS | Records | Elapsed min | Unsuccessful min |", "| --- | ---: | ---: | ---: |");
  for (const row of bucket(job => `${job.repository} / ${job.workflow} / ${job.job} / ${job.os}`).slice(0, 30))
    lines.push(`| ${escape(row.key)} | ${row.jobs} | ${(row.seconds / 60).toFixed(2)} | ${(row.unsuccessful_seconds / 60).toFixed(2)} |`);
  lines.push("", "## Daily elapsed totals (UTC job start)", "", "| Day | Repository | Elapsed min |", "| --- | --- | ---: |");
  for (const row of bucket(job => `${job.started_at?.slice(0, 10) ?? "unknown"} / ${job.repository}`).sort((a, b) => a.key.localeCompare(b.key)))
    lines.push(`| ${escape(row.key).replace(" / ", " | ")} | ${(row.seconds / 60).toFixed(2)} |`);
  lines.push("", "## Timing and coverage", "",
    "`jobs.json` keeps time from run creation until each job starts; this includes dependencies, approval and concurrency waits and is not provider queue time. `runs.json` keeps run start timestamps separately. `attempts.json` gives observed job span per attempt (earliest job start to latest completion); carried-forward jobs are excluded from later attempt spans. This is not an authoritative provider pipeline wall time.", "",
    `Requests: ${data.requests}; cached attempts reused: ${data.cached_attempts}. Organization discovery gaps: ${data.discovery_errors.length ? escape(data.discovery_errors.join("; ")) : "none"}.`, "");
  const unverified = data.jobs.filter(job => job.duration_state === "unverified");
  if (unverified.length) {
    lines.push("Unverified timestamp spans excluded from measured runner totals:", "", "| Job | Timestamp span min | Outcome |", "| --- | ---: | --- |");
    for (const job of unverified) lines.push(`| [${escape(job.repository + " / " + job.job)}](${job.url}) | ${((job.timestamp_span_seconds ?? 0) / 60).toFixed(2)} | ${escape(job.conclusion)} |`);
    lines.push("");
  }
  for (const repo of data.repositories) {
    for (const attempt of repo.empty_attempts ?? []) lines.push(`No job records returned: [${escape(repo.repository)} run ${attempt.run_id}, attempt ${attempt.attempt}](https://github.com/${repo.repository}/actions/runs/${attempt.run_id}). No runner duration inferred.`, "");
  }
  return lines.join("\n");
}

async function collect({ api = github, repositories, organizations = [], groups: requestedGroups = {}, from, to, output, now = new Date(), refreshHours = 6, progress = () => {} }) {
  const asOf = now.toISOString();
  const cachePath = path.join(output, "cache.json");
  let cache;
  try { cache = JSON.parse(await fs.readFile(cachePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (cache && cache.version !== 1) throw new Error("Unsupported cache version");
  cache ??= { version: 1, attempts: {} };
  let requests = 0, cachedAttempts = 0;
  const request = async endpoint => { requests++; return api(endpoint); };
  const groups = { ...requestedGroups }, discoveryErrors = [], repoNames = new Set(repositories.map(repo => repo.toLowerCase()));
  for (const repos of Object.values(groups)) for (const repo of repos) repoNames.add(repo.toLowerCase());
  for (const org of organizations) {
    try {
      const discovered = await pages(request, `orgs/${org}/repos?type=all`, null);
      groups[`${org} organization`] = discovered.map(repo => repo.full_name.toLowerCase());
      for (const repo of groups[`${org} organization`]) repoNames.add(repo);
    } catch (error) { discoveryErrors.push(`${org}: ${error.message}`); groups[`${org} organization`] = []; }
  }
  const records = [], allRuns = [], coverage = [];
  for (const repository of repoNames) {
    const entry = { repository, errors: [], run_count: null, empty_attempts: [] };
    coverage.push(entry);
    let runs;
    try { runs = await runsInWindow(request, repository, from, to); entry.run_count = runs.length; }
    catch (error) { entry.errors.push(error.message); continue; }
    progress(`${repository}: ${runs.length} runs`);
    let done = 0;
    // Three read-only requests at a time; stop on API errors and preserve explicit gaps.
    const pending = [...runs];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (pending.length) {
        const run = pending.shift();
        allRuns.push({ ...run, repository, source_repository: run.repository });
        for (let attempt = 1; attempt <= (run.run_attempt ?? 1); attempt++) {
          const key = `${repository}/${run.id}/${attempt}`;
          const saved = cache.attempts[key];
          const old = stamp(run.updated_at) < now.getTime() - refreshHours * 3600000;
          const canReuse = saved && saved.run_updated_at === run.updated_at && old && run.status === "completed"
            && saved.jobs.every(job => job.status === "completed");
          try {
            const jobs = canReuse ? saved.jobs : await pages(request,
              `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
            if (canReuse) cachedAttempts++;
            if (!jobs.length) entry.empty_attempts.push({ run_id: run.id, attempt });
            cache.attempts[key] = { run_updated_at: run.updated_at, fetched_at: canReuse ? saved.fetched_at : asOf, jobs };
            records.push({ repository, run, attempt, jobs });
          } catch (error) { entry.errors.push(`run ${run.id} attempt ${attempt}: ${error.message}`); }
        }
        if (++done % 100 === 0) progress(`${repository}: ${done}/${runs.length} runs collected`);
      }
    }));
    // Checkpoint completed reads so an interrupted collection can resume cheaply.
    await writePrivate(cachePath, cache);
  }
  const jobs = normalize(records, asOf);
  const copies = new Set(jobs.filter(job => job.duration_state === "carried_forward").map(job => `${job.repository}/${job.job_id}`));
  const attempts = records.map(record => {
    const own = record.jobs.filter(job => (job.run_attempt ?? record.attempt) === record.attempt && job.conclusion !== "skipped"
      && !copies.has(`${record.repository}/${job.id}`) && (Number(job.runner_id) > 0 || Boolean(job.runner_name)));
    const starts = own.map(job => stamp(job.started_at)).filter(Number.isFinite);
    const ends = own.map(job => stamp(job.completed_at)).filter(Number.isFinite);
    const start = starts.length ? new Date(Math.min(...starts)).toISOString() : null;
    const complete = own.length > 0 && own.every(job => job.status === "completed" && Number.isFinite(stamp(job.completed_at)));
    const end = complete && ends.length ? new Date(Math.max(...ends)).toISOString() : null;
    return { repository: record.repository, run_id: record.run.id, attempt: record.attempt,
      observed_started_at: start, observed_completed_at: end, observed_job_span_seconds: seconds(start, end) };
  });
  const data = { version: 1, as_of: asOf, from: iso(from), to: iso(to), repositories: coverage,
    discovery_errors: discoveryErrors, groups, requests, cached_attempts: cachedAttempts, jobs };
  await writePrivate(path.join(output, "raw.json"), records);
  await writePrivate(path.join(output, "runs.json"), allRuns);
  await writePrivate(path.join(output, "attempts.json"), attempts);
  await writePrivate(path.join(output, "jobs.json"), jobs);
  await writePrivate(path.join(output, "collection.json"), { ...data, jobs: undefined });
  await writePrivate(path.join(output, "report.md"), report(data), false);
  for (const { repository } of coverage) {
    await writePrivate(path.join(output, `${repository.replace("/", "--")}.md`), report({ ...data,
      repositories: coverage.filter(repo => repo.repository === repository),
      groups: {}, jobs: jobs.filter(job => job.repository === repository) }), false);
  }
  for (const [title, repos] of Object.entries(groups)) {
    await writePrivate(path.join(output, `group-${title.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`), report({ ...data,
      repositories: coverage.filter(repo => repos.includes(repo.repository)),
      groups: { [title]: repos }, jobs: jobs.filter(job => repos.includes(job.repository)) }), false);
  }
  return data;
}

async function writePrivate(file, value, json = true) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, json ? JSON.stringify(value, null, 2) + "\n" : value, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

async function privateOutput(directory) {
  const resolved = path.resolve(directory);
  const repo = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname });
  const root = await fs.realpath(repo.stdout.trim());
  // Resolve existing ancestor symlinks before creating output, including /tmp on macOS.
  let ancestor = resolved;
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
  }
  if (ancestor === root || ancestor.startsWith(root + path.sep)) throw new Error("Output must be outside this public repository");
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(resolved);
  if (real === root || real.startsWith(root + path.sep)) throw new Error("Output must be outside this public repository");
  await fs.chmod(real, 0o700);
  return real;
}

function argumentsFor(argv, now = new Date()) {
  const options = { repositories: [], organizations: [], groups: Object.create(null) };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--repo" && /^[\w.-]+\/[\w.-]+$/.test(value)) options.repositories.push(value);
    else if (flag === "--org" && /^[\w-]+$/.test(value)) options.organizations.push(value);
    else if (flag === "--group" && /^[a-zA-Z0-9 -]+=[\w.-]+\/[\w.-]+(?:,[\w.-]+\/[\w.-]+)*$/.test(value)) {
      const [title, list] = value.split("=");
      options.groups[title] = [...new Set(list.toLowerCase().split(","))];
    }
    else if (["--from", "--to"].includes(flag) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(stamp(value)) && iso(stamp(value) / 1000) === value) options[flag.slice(2)] = stamp(value) / 1000;
    else if (flag === "--output") options.output = value;
    else throw new Error(`Invalid option: ${flag}`);
  }
  options.to ??= Math.floor(now.getTime() / 1000);
  options.from ??= options.to - 30 * 86400;
  if (!options.output || (!options.repositories.length && !options.organizations.length && !Object.keys(options.groups).length) || options.from >= options.to || options.to > now.getTime() / 1000)
    throw new Error("Require --output, --repo or --org, and a past, increasing UTC time range");
  return options;
}

if (require.main === module) {
  if (process.argv.includes("--help")) console.log("node scripts/ci-usage.cjs --repo OWNER/REPO [--repo ...] [--org ORG] [--group 'NAME=OWNER/REPO,...'] --output PRIVATE_DIR [--from UTC_ISO --to UTC_ISO]\nDefaults to the past 30 days; end is exclusive. Uses authenticated gh; read-only. Reuses PRIVATE_DIR/cache.json. Billing is not collected.");
  else (async () => {
    const options = argumentsFor(process.argv.slice(2));
    options.output = await privateOutput(options.output);
    const result = await collect({ ...options, progress: text => console.error(text) });
    console.log(JSON.stringify({ output: options.output, jobs: result.jobs.length, requests: result.requests,
      cached_attempts: result.cached_attempts, coverage: result.repositories, discovery_errors: result.discovery_errors }, null, 2));
    if (result.discovery_errors.length || result.repositories.some(repo => repo.errors.length)) process.exitCode = 2;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { pages, runsInWindow, runner, normalize, totals, report, collect, argumentsFor, privateOutput, github, writePrivate };

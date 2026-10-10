// Provider billing is independent of the run-created cohort in ci-usage.cjs.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { github, privateOutput, writePrivate, totals } = require("./ci-usage.cjs");
const execute = promisify(execFile);
const key = value => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const escape = value => String(value ?? "unknown").replace(/[|\r\n]/g, " ");
const money = value => value === null ? "unknown" : `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const fields = ["quantity", "grossAmount", "discountAmount", "netAmount"];

function normalize(items, owner, month, summary = false) {
  if (!Array.isArray(items)) throw new Error("Invalid usageItems response");
  return items.filter(item => key(item.product) === "actions").map(item => {
    const quantity = summary ? item.grossQuantity : item.quantity;
    if (![quantity, item.pricePerUnit, item.grossAmount, item.discountAmount, item.netAmount].every(Number.isFinite))
      throw new Error("Actions billing record has missing/non-numeric quantities or amounts");
    const name = item.repositoryName;
    const repository = !name ? null : name.includes("/") ? name.toLowerCase()
      : `${item.organizationName ?? owner.name}/${name}`.toLowerCase();
    const row = { provider: "GitHub", owner_type: owner.type, owner: owner.name, month,
      repository, product: item.product, sku: item.sku, unit: item.unitType,
      date: item.date ?? null, quantity, rate: item.pricePerUnit,
      grossAmount: item.grossAmount, discountAmount: item.discountAmount, netAmount: item.netAmount };
    if (!row.sku || !row.unit || (repository && !repository.startsWith(owner.name.toLowerCase() + "/")))
      throw new Error("Actions billing record has invalid SKU, unit or repository owner");
    if (summary) Object.assign(row, { discountQuantity: item.discountQuantity ?? null, netQuantity: item.netQuantity ?? null });
    if (!summary && (!item.date || item.date.slice(0, 7) !== month))
      throw new Error("Actions billing record falls outside requested month");
    return row;
  });
}

function sum(rows) {
  return Object.fromEntries(fields.map(field => [field, rows.reduce((total, row) => total + row[field], 0)]));
}

function browserEvidence(observations) {
  if (!Array.isArray(observations)) throw new Error("Browser evidence must be an array");
  return observations.map(observation => {
    const url = new URL(observation.url);
    if (observation.provider !== "GitHub" || url.hostname !== "github.com" || url.pathname !== "/settings/billing/usage" ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(observation.month) || !/^[\w.-]+\/[\w.-]+$/.test(observation.repository) ||
        !url.searchParams.get("query")?.split(/\s+/).includes(`repo:${observation.repository}`) ||
        !url.searchParams.get("query")?.split(/\s+/).includes("product:actions") ||
        !Array.isArray(observation.chartLabels) || !observation.chartLabels.every(label => typeof label === "string"))
      throw new Error("Invalid browser billing scope/source");
    const displayed = observation.chartLabels.filter(label => /Billed: \$[\d.]+ /.test(label));
    const amounts = displayed.map(label => Number(label.match(/Billed: \$([\d.]+)/)[1]));
    return { ...observation, evidence_kind: "manually captured authenticated dashboard",
      precision: "Displayed amounts are rounded; quantities/rates are retained in detailText when captured. Not an exact API reconciliation.",
      displayed_billed_days: amounts.length,
      displayed_billed_sum: amounts.length ? amounts.reduce((total, amount) => total + amount, 0) : null };
  });
}

function reconcile(detail, summary) {
  if (detail.status !== "available" || summary.status !== "available")
    return { status: "unavailable", reason: "Both detail and summary must be accessible" };
  if (!detail.rows.length && !summary.rows.length) return { status: "empty", reason: "No Actions billing records returned; not proof of zero spend" };
  const groups = rows => {
    const result = new Map();
    for (const row of rows) {
      const group = `${key(row.sku)}/${key(row.unit)}`;
      if (!result.has(group)) result.set(group, []);
      result.get(group).push(row);
    }
    return result;
  };
  const left = groups(detail.rows), right = groups(summary.rows), differences = [];
  for (const group of new Set([...left.keys(), ...right.keys()])) {
    const a = sum(left.get(group) ?? []), b = sum(right.get(group) ?? []);
    for (const field of fields) if (Math.abs(a[field] - b[field]) > 1e-7)
      differences.push({ sku_unit: group, field, detail: a[field], summary: b[field], difference: a[field] - b[field] });
  }
  return { status: differences.length ? "mismatch" : "matched", differences };
}

async function probe(command, args) {
  try {
    const { stdout } = await execute(command, args, { timeout: 45000, maxBuffer: 32 * 1024 * 1024 });
    return { status: "available", data: command === "depot" && args.join(" ") === "org show" ? stdout.trim() : JSON.parse(stdout) };
  } catch (error) { return { status: "unavailable", error: (error.stderr || error.message).trim() }; }
}

async function depotInventory(org, base, run = probe) {
  const organization = await run("depot", ["org", "list", "--output", "json"]);
  const result = { organization_id: org, base_plan_usd: base ?? null,
    base_source: "User-confirmed monthly plan; not an invoice", base_allocated_to_repositories: false,
    organizations: organization, projects: null, builds: [],
    billing_status: "unavailable", billing_reason: "CLI inventory is not a billable-usage export; dashboard invoice/usage required" };
  if (organization.status !== "available" || !Array.isArray(organization.data) || !organization.data.some(item => (item.OrgId ?? item.id) === org)) {
    result.billing_reason = "Requested Depot organization was not verified by existing CLI authentication";
    return result;
  }
  result.current_organization = await run("depot", ["org", "show"]);
  if (result.current_organization.status !== "available" || result.current_organization.data !== org) {
    result.billing_reason = "Depot current organization does not match requested organization; no settings changed";
    return result;
  }
  result.projects = await run("depot", ["projects", "list", "--output", "json"]);
  if (result.projects.status !== "available" || !Array.isArray(result.projects.data)) return result;
  for (const project of result.projects.data) {
    const details = await run("depot", ["projects", "get", project.id, "--output", "json"]);
    const builds = await run("depot", ["list", "builds", "--project", project.id, "--output", "json"]);
    result.builds.push({ project, details, recent_builds: builds,
      duration_metric: "Elapsed wall seconds from build creation to finish; not billable runner minutes",
      coverage: "Recent CLI list only; pagination/history completeness and billable quantities are not established" });
  }
  return result;
}

function report(data, usage) {
  const lines = ["# CI billing reconciliation", "", `Collected ${data.collected_at}. Amounts are provider-reported USD; no elapsed-to-price estimate is made.`, "",
    "Billing months below are independent of the earlier run-created cohort. Billing entries can arrive later; missing access, no entries and a reconciled zero net amount are distinct. This is a usage report, not a final invoice.", "",
    "## GitHub billing owners", "", "| Owner | Month | Actions detail | Actions gross | Discount | Reported net | Detail vs summary |", "| --- | --- | --- | ---: | ---: | ---: | --- |"];
  const allocationNotes = [];
  for (const period of data.periods) {
    const known = period.detail.status === "available" && period.detail.rows.length > 0;
    const total = known ? sum(period.detail.rows) : null;
    lines.push(`| ${escape(period.owner.name)} (${period.owner.type}) | ${period.month} | ${period.detail.status === "available" ? period.detail.rows.length + " records" : "unavailable"} | ${money(total?.grossAmount ?? null)} | ${money(total?.discountAmount ?? null)} | ${money(total?.netAmount ?? null)} | ${period.reconciliation.status} |`);
  }
  for (const period of data.periods) {
    for (const response of [period.detail, period.summary]) if (response.error)
      lines.push("", `${escape(period.owner.name)} ${period.month} ${response.kind}: ${escape(response.error)}`, "");
    if (period.reconciliation.differences?.length) lines.push("", `Unreconciled differences: ${escape(JSON.stringify(period.reconciliation.differences))}`, "");
  }
  lines.push("", "## GitHub repository/SKU allocation", "", "| Repository | Month | SKU | Provider quantity | Unit | Rates | Gross | Discount | Net |", "| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: |");
  for (const period of data.periods) {
    const groups = new Map();
    for (const row of period.detail.rows ?? []) {
      const identity = JSON.stringify([row.repository, row.sku, row.unit]);
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push(row);
    }
    for (const rows of groups.values()) {
      const first = rows[0], total = sum(rows);
      lines.push(`| ${escape(first.repository ?? "unallocated account usage")} | ${period.month} | ${escape(first.sku)} | ${total.quantity} | ${escape(first.unit)} | ${[...new Set(rows.map(row => row.rate))].join(", ")} | ${money(total.grossAmount)} | ${money(total.discountAmount)} | ${money(total.netAmount)} |`);
    }
    const rows = period.detail.rows ?? [];
    const selected = rows.filter(row => row.repository && usage.repositories.some(repo => repo.repository === row.repository));
    const unmatched = rows.filter(row => !row.repository || !usage.repositories.some(repo => repo.repository === row.repository));
    if (rows.length) allocationNotes.push(`${escape(period.owner.name)} ${period.month}: selected repositories ${money(sum(selected).netAmount)} net; other/unallocated records ${money(sum(unmatched).netAmount)} net. Their sum ${money(sum(rows).netAmount)} matches the detail total; provider summary status is ${period.reconciliation.status}.`);
  }
  for (const note of allocationNotes) lines.push("", note, "");
  lines.push("", "## Separate project views", "", "| Repository | Observed cohort elapsed min | Billing month | Reported repository net | Coverage |", "| --- | ---: | --- | ---: | --- |");
  for (const repo of usage.repositories) {
    const elapsed = totals(usage.jobs.filter(job => job.repository === repo.repository)).seconds / 60;
    for (const month of data.months) {
      const ownerName = repo.repository.split("/")[0];
      const period = data.periods.find(item => item.owner.name.toLowerCase() === ownerName && item.month === month);
      const rows = period?.detail.rows?.filter(row => row.repository === repo.repository) ?? [];
      lines.push(`| ${escape(repo.repository)} | ${elapsed.toFixed(2)} | ${month} | ${money(rows.length ? sum(rows).netAmount : null)} | ${!period || period.detail.status !== "available" ? "billing owner access unavailable" : !rows.length ? "no repository billing entries; not proof of zero spend" : period.reconciliation.status === "matched" ? "provider detail and owner summary matched" : "owner summary not reconciled"} |`);
    }
  }
  lines.push("", "## Free compute policy versus billing evidence", "",
    "Standard GitHub-hosted runners are free for public repositories and for Dependabot. This policy does not establish artifact/cache charges or an account invoice. Larger/custom runners must not be assumed free. [GitHub billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions).", "");
  const standard = job => job.provider === "GitHub-hosted" && job.labels.some(label =>
    /^(ubuntu-(latest|\d{2}\.\d{2})(-arm)?|macos-(latest|\d+)(-intel)?|windows-(latest|\d{4}))$/.test(label));
  for (const metadata of data.repository_metadata) {
    const jobs = usage.jobs.filter(job => job.repository === metadata.repository && job.duration_state === "measured");
    if (metadata.status === "available" && metadata.private === false && jobs.length && jobs.every(standard))
      lines.push(`${escape(metadata.repository)} is currently public; all ${jobs.length} measured executions in the selected cohort have standard GitHub-hosted labels. Compute is expected free under that policy; historical visibility and other charges are not established by this check.`, "");
    const dependabotRuns = new Set((usage.runs ?? []).filter(run => run.repository === metadata.repository &&
      /^dynamic\/dependabot\//.test(run.path ?? "")).map(run => run.id));
    const dependabot = jobs.filter(job => dependabotRuns.has(job.run_id) && standard(job));
    if (dependabot.length) lines.push(`${escape(metadata.repository)}: ${dependabot.length} measured standard-runner Dependabot jobs (${(totals(dependabot).seconds / 60).toFixed(2)} elapsed minutes) are expected free compute. Billing access/other repository charges remain separate.`, "");
  }
  for (const [title, repos] of Object.entries(usage.groups)) {
    for (const month of data.months) {
      const rows = data.periods.filter(period => period.month === month).flatMap(period => period.detail.rows ?? []).filter(row => repos.includes(row.repository));
      const unknown = repos.filter(repo => !rows.some(row => row.repository === repo));
      lines.push("", `${escape(title)} ${month}: ${rows.length ? money(sum(rows).netAmount) + " reported net in mapped records" : "no mapped billing records"}; ${unknown.length ? "no repository billing records for " + unknown.map(escape).join(", ") : "all selected repositories represented"}. These rollups overlap; do not add them together.`);
    }
  }
  lines.push("", "## Authenticated browser observations", "");
  if (!data.browser_evidence?.length) lines.push("No browser evidence imported; API access gaps remain.");
  else {
    lines.push("These selected repository views supplement unavailable personal billing APIs. They do not replace exact owner-level detail/summary reconciliation. Displayed amounts are rounded; N/A/no entries remain unknown. Provider quantities/rates and raw display text are retained privately when captured.", "",
      "| Repository | Month | Displayed billed sum | Days with amounts | Evidence |", "| --- | --- | ---: | ---: | --- |");
    for (const observation of data.browser_evidence) lines.push(`| ${escape(observation.repository)} | ${observation.month} | ${money(observation.displayed_billed_sum)} | ${observation.displayed_billed_days} | [Authenticated dashboard](${observation.url}); rounded display |`);
  }
  lines.push("", "## Depot", "");
  if (!data.depot) lines.push("Depot billing was not collected.");
  else {
    const depot = data.depot;
    lines.push(`Organization: ${escape(depot.organization_id)}. **Base plan ${depot.base_plan_usd === null ? "unknown" : "$" + depot.base_plan_usd + "/month"}**, source: ${depot.base_source}. It appears once at account level and is not allocated per repository.`, "",
      `**Billable usage, overage and invoiced net: ${depot.billing_status}.** ${escape(depot.billing_reason)}.`, "");
    for (const item of depot.builds) {
      const builds = Array.isArray(item.recent_builds.data) ? item.recent_builds.data : [];
      const dates = builds.map(build => build.startTime).filter(Boolean).sort();
      lines.push(`Project ${escape(item.project.name)} (${escape(item.project.id)}): ${item.recent_builds.status}, ${builds.length} recent records${dates.length ? `, ${dates[0]} through ${dates.at(-1)}` : ""}. ${item.coverage}.`, "");
      if (item.details.error) lines.push(`Project detail access: ${escape(item.details.error)}`, "");
      const terminal = builds.filter(build => ["finished", "failed", "cancelled"].includes(build.status) && Number.isFinite(build.duration));
      lines.push(`${terminal.length} terminal records sum to ${terminal.reduce((total, build) => total + build.duration, 0)} creation-to-finish wall seconds. This is a partial elapsed observation, not monthly billable usage. [CLI duration definition](https://github.com/depot/cli/blob/main/pkg/helpers/buildlist.go).`, "");
    }
  }
  lines.push("", "## Coverage and next action", "",
    `Source job cohort: ${usage.from} ≤ run creation < ${usage.to}. It is not compared numerically to whole-month billed quantities. Billing storage/cache and other SKUs keep their provider units and rates.`, "",
    "GitHub and Depot remain separate provider views. Depot-backed jobs in the execution report are not added as a second elapsed-minute total; no Depot project is assigned to a repository merely by matching its name. The confirmed base plan is a budget commitment, not evidence of a paid invoice or zero overage.", "",
    "Next: resolve personal GitHub billing access and Depot usage/invoice access, rerun this report, and retain any summary mismatch or unmatched charge before choosing a runner migration.", "",
    "Sources: [GitHub billing API](https://docs.github.com/en/rest/billing/usage), [GitHub Actions billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Depot usage/analytics](https://depot.dev/docs/github-actions/observability/github-actions-metrics).", "");
  return lines.join("\n");
}

async function collect({ owners, months, usage, output, api = github, depotOrg, depotBase, depotProbe = probe, browserObservations = [], now = new Date() }) {
  const periods = [];
  for (const owner of owners) for (const month of months) {
    const endpoint = owner.type === "organization" ? `organizations/${owner.name}` : `users/${owner.name}`;
    const [year, monthNumber] = month.split("-").map(Number);
    const period = { owner, month };
    for (const kind of ["detail", "summary"]) {
      let raw;
      try {
        raw = await api(`${endpoint}/settings/billing/usage${kind === "summary" ? "/summary" : ""}?year=${year}&month=${monthNumber}`);
        if (kind === "summary" && (raw.timePeriod?.year !== year || raw.timePeriod?.month !== monthNumber))
          throw new Error("Summary reporting period does not match requested month");
        period[kind] = { kind, status: "available", raw, rows: normalize(raw.usageItems, owner, month, kind === "summary") };
      } catch (error) { period[kind] = { kind, status: "unavailable", raw, error: (error.stderr || error.message).trim(), rows: [] }; }
    }
    period.reconciliation = reconcile(period.detail, period.summary);
    periods.push(period);
  }
  const repositoryMetadata = [];
  for (const { repository } of usage.repositories) {
    try {
      const raw = await api(`repos/${repository}`);
      repositoryMetadata.push({ repository, status: "available", private: raw.private, visibility: raw.visibility });
    } catch (error) { repositoryMetadata.push({ repository, status: "unavailable", error: error.message }); }
  }
  const data = { version: 1, collected_at: now.toISOString(), months, periods,
    repository_metadata: repositoryMetadata,
    browser_evidence: browserEvidence(browserObservations),
    depot: depotOrg ? await depotInventory(depotOrg, depotBase, depotProbe) : null };
  await writePrivate(path.join(output, "billing.json"), data);
  await writePrivate(path.join(output, "billing.md"), report(data, usage), false);
  return data;
}

function argumentsFor(argv) {
  const result = { owners: [], months: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (["--user", "--org"].includes(flag) && /^[\w-]+$/.test(value)) result.owners.push({ type: flag === "--user" ? "user" : "organization", name: value.toLowerCase() });
    else if (flag === "--month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) result.months.push(value);
    else if (["--usage-dir", "--output", "--browser-evidence"].includes(flag)) result[flag === "--usage-dir" ? "usageDirectory" : flag === "--browser-evidence" ? "browserEvidenceFile" : "output"] = value;
    else if (flag === "--depot-org" && /^[\w-]+$/.test(value)) result.depotOrg = value;
    else if (flag === "--depot-base-usd" && /^\d+(\.\d+)?$/.test(value)) result.depotBase = Number(value);
    else throw new Error(`Invalid option: ${flag}`);
  }
  result.owners = [...new Map(result.owners.map(owner => [owner.name, owner])).values()];
  result.months = [...new Set(result.months)];
  if (!result.owners.length || !result.months.length || !result.output || !result.usageDirectory || (result.depotBase !== undefined && !result.depotOrg))
    throw new Error("Require billing owner, month, --usage-dir and private --output; Depot base requires --depot-org");
  return result;
}

if (require.main === module) {
  if (process.argv.includes("--help")) console.log("node scripts/ci-billing.cjs --org ORG --user USER --month YYYY-MM [--month ...] --usage-dir CI_USAGE_DIR --output PRIVATE_DIR [--depot-org ID --depot-base-usd AMOUNT] [--browser-evidence PRIVATE_JSON]\nRead-only existing gh/depot authentication; no login or credential changes. Missing billing stays unknown. Depot CLI inventory is not a usage invoice.");
  else (async () => {
    const options = argumentsFor(process.argv.slice(2));
    options.output = await privateOutput(options.output);
    const usage = JSON.parse(await fs.readFile(path.join(options.usageDirectory, "collection.json"), "utf8"));
    usage.jobs = JSON.parse(await fs.readFile(path.join(options.usageDirectory, "jobs.json"), "utf8"));
    usage.runs = JSON.parse(await fs.readFile(path.join(options.usageDirectory, "runs.json"), "utf8"));
    if (options.browserEvidenceFile) options.browserObservations = JSON.parse(await fs.readFile(options.browserEvidenceFile, "utf8"));
    const data = await collect({ ...options, usage });
    console.log(JSON.stringify({ output: options.output, periods: data.periods.map(period => ({ owner: period.owner.name,
      month: period.month, detail: period.detail.status, reconciliation: period.reconciliation.status })), depot_billing: data.depot?.billing_status }, null, 2));
    if (data.periods.some(period => !["matched", "empty"].includes(period.reconciliation.status)) || data.depot?.billing_status === "unavailable") process.exitCode = 2;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { normalize, sum, reconcile, report, collect, depotInventory, argumentsFor, browserEvidence };

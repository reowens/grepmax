const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalize, sum, reconcile, report, collect, depotInventory, argumentsFor, browserEvidence } = require("./ci-billing.cjs");
const owner = { type: "organization", name: "example" };
const item = { date: "2026-09-01T00:00:00Z", product: "actions", sku: "Actions Linux", quantity: 100,
  unitType: "Minutes", pricePerUnit: 0.006, grossAmount: 0.6, discountAmount: 0.6, netAmount: 0,
  organizationName: "example", repositoryName: "repo" };
const summaryItem = { ...item, sku: "actions_linux", unitType: "minutes", grossQuantity: 100, discountQuantity: 100, netQuantity: 0 };
const detail = items => ({ status: "available", rows: normalize(items, owner, "2026-09") });
const summary = items => ({ status: "available", rows: normalize(items, owner, "2026-09", true) });
const usage = { from: "2026-09-10T00:00:00Z", to: "2026-10-10T00:00:00Z", groups: { Product: ["example/repo", "person/private"] },
  repositories: [{ repository: "example/repo" }, { repository: "person/private" }], jobs: [], runs: [] };

test("provider quantity, rates, discounts and net stay separate; non-Actions remains raw", () => {
  const rows = normalize([item, { ...item, product: "Copilot" }], owner, "2026-09");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repository, "example/repo");
  assert.equal(rows[0].rate, 0.006);
  assert.deepEqual(sum(rows), { quantity: 100, grossAmount: 0.6, discountAmount: 0.6, netAmount: 0 });
  const other = normalize([{ ...item, repositoryName: "example/other" }], owner, "2026-09");
  assert.equal(other[0].repository, "example/other");
  assert.equal(normalize([{ ...item, repositoryName: null }], owner, "2026-09")[0].repository, null);
});

test("different SKU/unit groups reconcile without adding unlike quantities", () => {
  const storage = { ...item, sku: "Actions Storage", quantity: 5, unitType: "GB-hours", pricePerUnit: 0.01,
    grossAmount: 0.05, discountAmount: 0, netAmount: 0.05 };
  const storageSummary = { ...storage, sku: "actions_storage", grossQuantity: 5 };
  assert.equal(reconcile(detail([item, storage]), summary([summaryItem, storageSummary])).status, "matched");
  const changed = { ...summaryItem, netAmount: 0.05 };
  const result = reconcile(detail([item]), summary([changed]));
  assert.equal(result.status, "mismatch");
  assert.deepEqual(result.differences[0], { sku_unit: "actionslinux/minutes", field: "netAmount", detail: 0, summary: 0.05, difference: -0.05 });
});

test("unavailable, empty and reconciled zero are distinct", () => {
  assert.equal(reconcile({ status: "unavailable", rows: [] }, summary([])).status, "unavailable");
  assert.equal(reconcile(detail([]), summary([])).status, "empty");
  assert.equal(reconcile(detail([item]), summary([summaryItem])).status, "matched");
  assert.equal(sum(detail([item]).rows).netAmount, 0);
});

test("missing numeric values, wrong month, owner and schema fail explicitly", () => {
  assert.throws(() => normalize([{ ...item, netAmount: undefined }], owner, "2026-09"), /non-numeric/);
  assert.throws(() => normalize([{ ...item, quantity: "100" }], owner, "2026-09"), /non-numeric/);
  assert.throws(() => normalize([{ ...item, date: "2026-10-01" }], owner, "2026-09"), /outside/);
  assert.throws(() => normalize([{ ...item, repositoryName: "other/repo" }], owner, "2026-09"), /owner/);
  assert.throws(() => normalize({}, owner, "2026-09"), /Invalid/);
});

test("collection preserves inaccessible owners and mismatched summary period", async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ci-billing-test-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const api = async endpoint => {
    if (endpoint.startsWith("repos/")) return { private: true, visibility: "private" };
    if (endpoint.startsWith("users/")) throw new Error("HTTP 404; needs user scope");
    return endpoint.includes("/summary?") ? { timePeriod: { year: 2026, month: 10 }, usageItems: [summaryItem] }
      : { usageItems: [item] };
  };
  const data = await collect({ owners: [owner, { type: "user", name: "person" }], months: ["2026-09"], usage, output, api });
  assert.equal(data.periods[0].detail.status, "available");
  assert.match(data.periods[0].summary.error, /period/);
  assert.equal(data.periods[0].summary.raw.timePeriod.month, 10);
  assert.equal(data.periods[1].reconciliation.status, "unavailable");
  assert.match(await fs.readFile(path.join(output, "billing.md"), "utf8"), /scope/);
  assert.equal((await fs.stat(path.join(output, "billing.json"))).mode & 0o777, 0o600);
});

test("Depot inventory never converts elapsed duration into billable quantity or duplicates base", async () => {
  const run = async (command, args) => {
    if (args[0] === "org") return { status: "available", data: args[1] === "show" ? "org-id" : [{ OrgId: "org-id", Name: "Example" }] };
    if (args[0] === "projects" && args[1] === "list") return { status: "available", data: [{ id: "project", name: "repo" }] };
    if (args[0] === "projects") return { status: "unavailable", error: "Invalid token" };
    return { status: "available", data: [{ id: "build", startTime: "2026-09-30T00:00:00Z", duration: 120 }] };
  };
  const depot = await depotInventory("org-id", 20, run);
  assert.equal(depot.billing_status, "unavailable");
  assert.equal(depot.base_allocated_to_repositories, false);
  assert.equal(depot.builds[0].recent_builds.data[0].duration, 120);
  assert.equal(depot.builds[0].billable_minutes, undefined);
  const data = { collected_at: "2026-10-10", periods: [], months: [], repository_metadata: [], depot };
  const rendered = report(data, usage);
  assert.equal(rendered.split("$20/month").length - 1, 1);
  assert.match(rendered, /Billable usage, overage and invoiced net: unavailable/);
});

test("Depot mismatch does not switch organizations or query another account's projects", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args.join(" "));
    return { status: "available", data: args[1] === "show" ? "different" : [{ id: "requested" }] };
  };
  const result = await depotInventory("requested", 20, run);
  assert.deepEqual(calls, ["org list --output json", "org show"]);
  assert.match(result.billing_reason, /does not match/);
});

test("repository allocation preserves unselected/unallocated charges and empty rows stay unknown", () => {
  const data = { collected_at: "2026-10-10", months: ["2026-09", "2026-10"], repository_metadata: [], depot: null,
    periods: [{ owner, month: "2026-09", detail: detail([item, { ...item, repositoryName: null, netAmount: 0.25 }]),
      summary: summary([]), reconciliation: { status: "mismatch" } },
    { owner, month: "2026-10", detail: detail([]), summary: summary([]), reconciliation: { status: "empty" } }] };
  const rendered = report(data, usage);
  assert.match(rendered, /other\/unallocated records \$0.25 net/);
  assert.match(rendered, /no repository billing entries; not proof of zero spend/);
  assert.match(rendered, /billing owner access unavailable/);
  assert.match(rendered, /unallocated account usage/);
});

test("free policy requires standard hosted labels and real Dependabot run path", () => {
  const data = { collected_at: "2026-10-10", months: [], periods: [], depot: null,
    repository_metadata: [{ repository: "example/repo", status: "available", private: false }] };
  const fixture = { ...usage, jobs: [{ repository: "example/repo", job_id: 1, run_id: 10,
    provider: "GitHub-hosted", labels: ["ubuntu-latest"], duration_state: "measured", duration_seconds: 60 }],
    runs: [{ repository: "example/repo", id: 10, path: "dynamic/dependabot/dependabot-updates" }] };
  assert.match(report(data, fixture), /1 measured standard-runner Dependabot jobs/);
  assert.match(report(data, fixture), /Compute is expected free/);
  fixture.jobs[0].labels = ["macos-15-xlarge"];
  assert.doesNotMatch(report(data, fixture), /Compute is expected free/);
  assert.doesNotMatch(report(data, fixture), /1 measured standard-runner Dependabot/);
});

test("CLI rejects unknown flags and duplicate owner/month requests do not duplicate billing", () => {
  const options = argumentsFor(["--org", "example", "--org", "EXAMPLE", "--month", "2026-09", "--month", "2026-09",
    "--usage-dir", "/tmp/usage", "--output", "/tmp/billing", "--depot-org", "id", "--depot-base-usd", "20"]);
  assert.equal(options.owners.length, 1);
  assert.deepEqual(options.months, ["2026-09"]);
  assert.equal(options.depotBase, 20);
  assert.throws(() => argumentsFor(["--month", "2026-13"]), /Invalid/);
  assert.throws(() => argumentsFor(["--org", "example"]), /Require/);
});

test("authenticated browser evidence keeps rounded billed values and N/A distinct", () => {
  const observation = { provider: "GitHub", repository: "example/repo", month: "2026-09",
    url: "https://github.com/settings/billing/usage?query=product%3Aactions%20repo%3Aexample%2Frepo",
    chartLabels: ["Usage Tuesday, Sep 1 2026, Gross: $0.60 Billed: $0.00 Discount: $0.60.",
      "Usage Wednesday, Sep 2 2026, Gross: N/A Billed: N/A Discount: N/A."] };
  const [known] = browserEvidence([observation]);
  assert.equal(known.displayed_billed_sum, 0);
  assert.equal(known.displayed_billed_days, 1);
  assert.match(known.precision, /rounded/);
  const [empty] = browserEvidence([{ ...observation, chartLabels: [observation.chartLabels[1]] }]);
  assert.equal(empty.displayed_billed_sum, null);
  assert.throws(() => browserEvidence([{ ...observation, repository: "other/repo" }]), /scope/);
  assert.throws(() => browserEvidence([{ ...observation, url: observation.url.replace("github.com", "example.com") }]), /source/);
});

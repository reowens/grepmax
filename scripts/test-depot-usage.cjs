const { test } = require("node:test");
const assert = require("node:assert/strict");
const { credential, client, windowFor, projectPages, validateUsage, depotUsage } = require("./depot-usage.cjs");
const now = new Date("2026-10-09T12:00:00Z");
const auth = async () => ({ token: "fixture-secret", source: "fixture" });
const identity = { status: "available", raw: { organizations: [{ orgId: "org-id", name: "Example" }] } };

test("credentials prefer existing environment token; stored token is captured without logging", async () => {
  const run = async (command, args) => {
    assert.equal(command, "depot"); assert.deepEqual(args, ["login", "token"]);
    return { stdout: "stored-secret\n" };
  };
  assert.deepEqual(await credential({ DEPOT_TOKEN: " env-secret " }, () => assert.fail()), { token: "env-secret", source: "DEPOT_TOKEN" });
  assert.deepEqual(await credential({}, run), { token: "stored-secret", source: "existing Depot CLI login" });
  await assert.rejects(credential({}, async () => { throw new Error("secret in stderr"); }), error => !error.message.includes("secret in stderr"));
});

test("API uses fixed vendor origin, rejects redirects/mutations and redacts reflected credentials", async () => {
  const call = client("fixture-secret", async (url, options) => {
    assert.equal(url, "https://api.depot.dev/depot.core.v1.UsageService/GetUsage");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    assert.deepEqual(JSON.parse(options.body), { startAt: "start" });
    return { ok: false, status: 401, text: async () => JSON.stringify({ code: "unauthenticated", message: "Invalid token fixture-secret" }) };
  });
  const result = await call("depot.core.v1.UsageService/GetUsage", { startAt: "start" });
  assert.equal(result.http_status, 401);
  assert.match(result.error, /Invalid token/);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  await assert.rejects(call("depot.core.v1.ProjectService/DeleteProject", {}), /read-only/);
  const broken = client("fixture-secret", async () => { throw new Error("fixture-secret network error"); });
  assert.ok(!JSON.stringify(await broken("depot.core.v1.UsageService/GetUsage", {})).includes("fixture-secret"));
});

test("completed calendar months and current partial month preserve exact requested bounds", () => {
  assert.deepEqual(windowFor("2026-09", now), { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T23:59:59.999Z" });
  assert.equal(windowFor("2026-10", now).endAt, now.toISOString());
  assert.equal(windowFor("2026-11", now), null);
  assert.throws(() => windowFor("2026-13", now), /month/);
});

test("usage preserves billed/elapsed/storage quantities and retrieves all project pages", async () => {
  const calls = [];
  const makeClient = token => {
    assert.equal(token, "fixture-secret");
    return async (method, request) => {
      calls.push({ method, request });
      if (method.endsWith("ListOrganizations")) return identity;
      if (method.endsWith("GetUsage")) return { status: "available", http_status: 200, raw: {
        periodStart: request.startAt, periodEnd: request.endAt,
        containerBuild: [{ projectName: "repo", buildCount: 2, minutesBilled: 3.5 }],
        githubActionsJobs: [{ repo: "example/repo", total: { jobCount: 1, minutesElapsed: 4, minutesBilled: 8 }, jobs: [] }],
        storage: [{ storageType: "cache", totalGb: 24.5 }]
      } };
      return { status: "available", raw: request.pageToken ? { usage: [{ projectId: "second", buildDurationSeconds: 60 }] }
        : { usage: [{ projectId: "first", buildDurationSeconds: 90 }], nextPageToken: "next" } };
    };
  };
  const result = await depotUsage("org-id", ["2026-09", "2026-09"], { now, getCredential: auth, makeClient });
  assert.equal(result.status, "available"); assert.equal(result.periods.length, 1);
  const period = result.periods[0];
  assert.equal(period.usage.raw.githubActionsJobs[0].total.minutesBilled, 8);
  assert.equal(period.usage.raw.githubActionsJobs[0].total.minutesElapsed, 4);
  assert.equal(period.usage.raw.storage[0].totalGb, 24.5);
  assert.equal(period.projects.records.length, 2);
  assert.equal(calls.at(-1).request.pageToken, "next");
  assert.equal(result.charge_status, "unknown");
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("wrong or ambiguous organization does not query usage", async () => {
  for (const organizations of [[{ orgId: "other" }], [{ orgId: "org-id" }, { orgId: "other" }]]) {
    const methods = [];
    const result = await depotUsage("org-id", ["2026-09"], { now, getCredential: auth,
      makeClient: () => async method => { methods.push(method); return { status: "available", raw: { organizations } }; } });
    assert.equal(result.status, "unavailable");
    assert.equal(methods.length, 1);
    assert.equal(result.periods.length, 0);
  }
});

test("401 usage stays unavailable and empty successful JSON is not proven zero", async () => {
  const failed = await depotUsage("org-id", ["2026-09", "2026-10"], { now, getCredential: auth,
    makeClient: () => async method => method.endsWith("ListOrganizations") ? identity
      : { status: "unavailable", http_status: 401, raw: { code: "unauthenticated", message: "Invalid token" }, error: "HTTP 401: Invalid token" } });
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.periods.length, 2);
  assert.equal(failed.periods[0].projects, undefined);
  const request = windowFor("2026-09", now);
  assert.match(validateUsage({}, request), /not proven zero/);
  assert.equal(validateUsage({ periodStart: request.startAt, periodEnd: request.endAt }, request), null);
  assert.match(validateUsage({ periodStart: request.startAt, periodEnd: now.toISOString() }, request), /differs/);
  assert.match(validateUsage({ periodStart: request.startAt, periodEnd: request.endAt, storage: [{ totalGb: "24" }] }, request), /quantities/);
});

test("pagination failures and repeated tokens remain partial; no invented zero total", async () => {
  let count = 0;
  const partial = await projectPages(async () => ++count === 1
    ? { status: "available", raw: { usage: [{ projectId: "first" }], nextPageToken: "next" } }
    : { status: "unavailable", error: "HTTP 403" }, {});
  assert.equal(partial.status, "partial"); assert.equal(partial.records.length, 1);
  const cycle = await projectPages(async () => ({ status: "available", raw: { usage: [], nextPageToken: "same" } }), {});
  assert.equal(cycle.status, "partial"); assert.match(cycle.error, /Repeated/);
});

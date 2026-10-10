// Read-only Connect JSON calls. Authentication stays in memory, outside reports.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const service = "depot.core.v1.UsageService";
const allowed = new Set(["depot.core.v1.OrganizationService/ListOrganizations",
  `${service}/GetUsage`, `${service}/ListProjectUsage`]);

async function credential(env = process.env, run = execute) {
  if (env.DEPOT_TOKEN?.trim()) return { token: env.DEPOT_TOKEN.trim(), source: "DEPOT_TOKEN" };
  try {
    const { stdout } = await run("depot", ["login", "token"], { timeout: 10000, maxBuffer: 65536 });
    const token = stdout.trim();
    if (!token || /\s/.test(token)) throw new Error();
    return { token, source: "existing Depot CLI login" };
  } catch { throw new Error("No usable existing Depot API credential; no login or credential changes performed"); }
}

function client(token, fetcher = fetch) {
  const redact = value => String(value).split(token).join("[redacted]");
  return async (method, request) => {
    if (!allowed.has(method)) throw new Error("Unsupported read-only Depot API method");
    try {
      const response = await fetcher(`https://api.depot.dev/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: JSON.stringify(request)
      });
      const raw = JSON.parse(redact(await response.text()));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Depot API response");
      return { status: response.ok ? "available" : "unavailable", http_status: response.status, raw,
        ...(!response.ok ? { error: `HTTP ${response.status}: ${raw.code ?? "unknown"}: ${raw.message ?? "request failed"}` } : {}) };
    } catch (error) { return { status: "unavailable", error: redact(error.message) }; }
  };
}

function windowFor(month, now) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid Depot reporting month");
  const [year, number] = month.split("-").map(Number);
  const start = Date.UTC(year, number - 1, 1), end = Math.min(Date.UTC(year, number, 1) - 1, now.getTime());
  if (start > end) return null;
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}

async function projectPages(call, request) {
  const pages = [], records = [], seen = new Set();
  let pageToken;
  do {
    const page = await call(`${service}/ListProjectUsage`, { ...request, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    pages.push(page);
    if (page.status !== "available") return { status: records.length ? "partial" : "unavailable", pages, records, error: page.error };
    if ((page.raw.usage !== undefined && !Array.isArray(page.raw.usage)) ||
        (page.raw.nextPageToken !== undefined && typeof page.raw.nextPageToken !== "string"))
      return { status: "partial", pages, records, error: "Invalid project usage page schema" };
    records.push(...(page.raw.usage ?? [])); // Protobuf JSON omits empty repeated fields.
    pageToken = page.raw.nextPageToken;
    if (pageToken && seen.has(pageToken)) return { status: "partial", pages, records, error: "Repeated project usage page token" };
    if (pageToken) seen.add(pageToken);
    if (pages.length >= 1000 && pageToken) return { status: "partial", pages, records, error: "Project usage pagination limit reached" };
  } while (pageToken);
  return { status: "available", pages, records };
}

function validateUsage(raw, request) {
  if (!Number.isFinite(Date.parse(raw.periodStart)) || !Number.isFinite(Date.parse(raw.periodEnd)))
    return "Missing/invalid provider reporting period; an empty object is not proven zero usage";
  if (Date.parse(raw.periodStart) !== Date.parse(request.startAt) || Date.parse(raw.periodEnd) !== Date.parse(request.endAt))
    return "Provider reporting period differs from requested window";
  if (["containerBuild", "githubActionsJobs", "storage", "agentSandbox"].some(name => raw[name] !== undefined && !Array.isArray(raw[name])))
    return "Invalid provider usage collections";
  const numeric = object => object && typeof object === "object" && !Array.isArray(object) &&
    ["buildCount", "minutesSaved", "minutesBilled", "jobCount", "minutesElapsed", "totalGb", "sandboxesCount"]
      .every(name => object[name] === undefined || (Number.isFinite(object[name]) && object[name] >= 0));
  for (const name of ["containerBuild", "githubActionsJobs", "storage", "agentSandbox"]) {
    if ((raw[name] ?? []).some(row => !numeric(row) ||
        (row.total !== undefined && !numeric(row.total)) ||
        (row.jobs !== undefined && (!Array.isArray(row.jobs) || row.jobs.some(job => !numeric(job))))))
      return "Invalid provider usage quantities";
  }
  return null;
}

async function depotUsage(org, months, { now = new Date(), getCredential = credential, makeClient = client } = {}) {
  const result = { status: "unavailable", organization_id: org, periods: [],
    source: "https://depot.dev/docs/api/sdk-reference#usage-service",
    charge_status: "unknown", charge_reason: "Usage API reports quantities, not invoice net, credits or remaining allowance" };
  let auth;
  try { auth = await getCredential(); } catch (error) { result.error = error.message; return result; }
  result.credential_source = auth.source;
  const call = makeClient(auth.token);
  const identity = await call("depot.core.v1.OrganizationService/ListOrganizations", {});
  result.organization_identity = identity;
  if (identity.status !== "available") { result.error = identity.error; return result; }
  const organizations = identity.raw.organizations;
  if (!Array.isArray(organizations) || organizations.length !== 1 || organizations[0].orgId !== org) {
    result.error = "API credential must identify exactly the requested Depot organization; usage was not queried";
    return result;
  }
  for (const month of [...new Set(months)]) {
    const request = windowFor(month, now);
    if (!request) { result.periods.push({ month, status: "unavailable", error: "Reporting month has not started" }); continue; }
    const response = await call(`${service}/GetUsage`, request);
    const period = { month, request, usage: response, status: response.status };
    if (response.status === "available") {
      const error = validateUsage(response.raw, request);
      if (error) { period.status = "unverified"; period.error = error; }
      // Project IDs are kept separate from name-only container usage; never infer a repository mapping.
      period.projects = await projectPages(call, request);
      if (period.projects.status !== "available" && period.status === "available") period.status = "partial";
    }
    result.periods.push(period);
  }
  result.status = result.periods.length && result.periods.every(period => period.status === "available") ? "available"
    : result.periods.some(period => period.usage?.status === "available") ? "partial" : "unavailable";
  return result;
}

module.exports = { credential, client, windowFor, projectPages, validateUsage, depotUsage };

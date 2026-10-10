# CI usage reports

Run `scripts/ci-usage.cjs` with Node 22 and an authenticated `gh` CLI. It only reads GitHub Actions APIs; it does not use the gmax daemon, start models, run builds or change workflows.

```sh
node scripts/ci-usage.cjs \
  --repo OWNER/REPO \
  --org ORGANIZATION \
  --group 'Product=OWNER/REPO,ORGANIZATION/OTHER_REPO' \
  --output /private/tmp/ci-usage
```

The default is the previous 30 days. For a repeatable window, supply `--from 2026-09-10T00:00:00Z --to 2026-10-10T00:00:00Z`; the end is exclusive and must be in the past. A group also adds its repositories to the collection. Organization discovery includes repositories visible to the authenticated identity; it cannot prove access to every private repository in an organization.

The output directory must be outside this public repository. Use a dedicated private directory, not a shared artifact location. Files are private to the current user. Do not commit private exports or upload them to public Actions artifacts. Run one collector per output directory at a time.

Outputs include a comparative `report.md`, separate repository and group reports, raw API observations, normalized `jobs.json`, `runs.json`, observed attempt timing in `attempts.json`, collection coverage and a reusable cache. Repeated collection refreshes run metadata and recent/active attempts. Completed attempts older than six hours reuse their jobs when run metadata has not changed. Inaccessible repositories and failed requests appear as coverage gaps; exit status 2 means a partial report was written. Exit status 1 means collection could not complete normally.

The collector paginates all jobs and attempts, partitions run-created date windows at GitHub's filtered search cap, and deduplicates records by repository/job ID. GitHub can also copy successful jobs into later attempts under new IDs. An exact match of run, commit, job name, runner, start/end and step timing across attempts identifies those copies; both records remain with an original execution ID, and elapsed duration counts once. Failed and cancelled attempts remain included. Skipped jobs add no elapsed duration. Active jobs, completed jobs with missing timestamps and timestamp spans without runner-assignment evidence are excluded from measured totals and remain visible separately. GitHub can give a cancelled job start/end timestamps even when it has no assigned runner; treating that span as execution would overstate usage.

Elapsed job minutes are **not billable minutes or charges**: no provider rounding, OS multipliers, allowance or rate is applied. Billing is a separate reconciliation step. Provider and OS classifications use runner labels and metadata; custom runners remain unknown when those fields do not establish their identity. Job-start delay includes dependencies, concurrency and approvals, so it is not called provider queue time. Attempt timing is an observed job span, not an authoritative pipeline wall time. Daily totals use job start dates; the selected cohort uses run creation dates, so retries can occur after the cohort's end. Deleted/API-invisible history is unavailable.

Organization and product groups can overlap. They are alternative views; adding them together double-counts shared repositories.

Verify offline with `node --test scripts/test-ci-usage.cjs`. Normal source CI runs these fixtures without authenticated API calls.

## Billing reconciliation

Collect complete billing months separately from the run-created cohort:

```sh
node scripts/ci-billing.cjs \
  --user PERSONAL_OWNER --org ORGANIZATION \
  --month 2026-09 --month 2026-10 \
  --usage-dir /private/tmp/ci-usage \
  --output /private/tmp/ci-billing \
  --depot-org DEPOT_ORGANIZATION_ID --depot-base-usd 20
```

The billing collector preserves raw GitHub responses and Actions quantities, units, rates, gross amounts, discounts and net amounts in private `billing.json`. `billing.md` shows repository allocations, unmatched account records and independent detail-versus-summary comparisons by SKU/unit. A failed request, an empty response and records with a reconciled zero net amount are separate states. Months and owners are deduplicated. No estimates are calculated from elapsed job time, and non-Actions products remain in raw responses.

Existing authenticated `gh` access must include the billing endpoint's permissions. An access error stays visible; this script does not broaden token scopes or log in. Optional Depot CLI probes verify the selected/current organization and preserve project/recent-build inventory. They do not switch organizations. Recent build durations are creation-to-finish wall seconds, including waiting; recent history is incomplete and does not establish billable runner minutes or overage. The supplied base amount is a user-confirmed account budget, appears once, and is not an invoice or per-repository allocation.

Authenticated browser observations can supplement unavailable billing APIs with `--browser-evidence PRIVATE_JSON`. The file is an array of records with `provider: "GitHub"`, `repository`, `month`, the filtered dashboard `url`, its `chartLabels` and optional expanded billing `detailText`. Capture these from the actual displayed view. The import retains rounded display values separately from exact API data; it does not treat N/A as zero or claim an owner-level reconciliation. Keep that file private too.

Exit status 2 means a report was written with unavailable/unreconciled billing. Billing can arrive after collection; a current-month empty response does not prove zero spend. Standard GitHub-hosted public-repository and Dependabot compute is free under GitHub's billing rules; larger runners and storage require separate evidence.

Verify both collectors offline with `node --test scripts/test-ci-usage.cjs scripts/test-ci-billing.cjs`.

Collection semantics: [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [per-attempt jobs](https://docs.github.com/en/rest/actions/workflow-jobs).
Billing semantics: [GitHub billing usage](https://docs.github.com/en/rest/billing/usage), [GitHub Actions billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Depot analytics](https://depot.dev/docs/github-actions/observability/github-actions-metrics), [Depot CLI build duration](https://github.com/depot/cli/blob/main/pkg/helpers/buildlist.go).

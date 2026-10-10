const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { nativeSourceDigest } = require("./bounded-source-digest.cjs");

// Only assemble binaries accepted by this source's dedicated platform jobs.
// The release workflow downloads both artifacts from its own run.
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) throw new Error("Expected artifact input and output directories");
const root = path.resolve(__dirname, "..");
const sourceSha256 = nativeSourceDigest(path.join(root, "lance-maintenance/native"));
const manifest = {schemaVersion: 1, engine: "12.0.0", sourceSha256, qualified: true, binaries: {}};
const acceptance = {schemaVersion: 1, sourceSha256, platforms: {}};
const verified = [];
const notices = [];
function read(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error(`Unsafe artifact: ${file}`);
  return fs.readFileSync(file);
}
for (const platform of ["darwin-arm64", "linux-x64"]) {
  const directory = path.join(input, `bounded-native-${platform}`);
  if (read(path.join(directory, "build-profile.txt"), 128).toString().trim() !== "release") throw new Error(`Shipping profile required: ${platform}`);
  const source = read(path.join(directory, "source.sha256"), 128).toString().trim();
  if (source !== sourceSha256) throw new Error(`Native source mismatch: ${platform}`);
  const capability = JSON.parse(read(path.join(directory, "capabilities.json"), 4096));
  if (capability.protocolVersion !== 1 || capability.engine !== "12.0.0" ||
      capability.nativeTotalWriteBudgetEnforced !== true || capability.budgetKind !== "cumulative-writes" ||
      capability.protectedReaderProtocol !== 1 || capability.incrementalRepairProtocol !== 1) throw new Error(`Incomplete native capabilities: ${platform}`);
  const binary = read(path.join(directory, "gmax-bounded-maintenance"), 256 * 1024**2);
  const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
  const proof = JSON.parse(read(path.join(directory, "acceptance.json"), 64 * 1024));
  if (proof.schemaVersion !== 1 || proof.verdict !== "PASS_BOUNDED_NATIVE_ACCEPTANCE" ||
      proof.engine !== "12.0.0" || proof.binarySha256 !== sha256 || !Number.isSafeInteger(proof.tests?.executed) ||
      proof.tests.executed < 21 || proof.tests.passed !== proof.tests.executed || proof.tests.skipped !== 0 ||
      proof.tests.failures !== 0 || proof.tests.errors !== 0 ||
      !Array.isArray(proof.testCases) || proof.testCases.length !== proof.tests.executed ||
      new Set(proof.testCases).size !== proof.testCases.length) throw new Error(`Incomplete native acceptance: ${platform}`);
  if (proof.sourceDigest !== sourceSha256 || proof.provenanceUnchanged !== true) throw new Error(`Native proof provenance mismatch: ${platform}`);
  for (const test of [
    "test_real_selected_batch_preserves_rows_indices_tags_and_both_readers",
    "test_budget_exhaustion_after_data_copy_is_safe_and_never_refunded",
    "test_interruption_at_protected_and_committed_reader_windows_preserves_head",
    "test_pre_receipt_zero_payload_journal_is_safely_retired_on_admitted_attempt",
    "test_production_executable_rejects_qualification_fault_fields",
    "test_recovery_uses_remaining_original_cap_after_its_own_space_consumption",
    "test_verified_copy_recovery_preserves_subsequent_watched_edits",
    "test_fragment_selected_index_refresh_and_interruption",
    "test_partial_relocation_preserves_values_and_protected_reader",
    "test_newer_orphan_requires_complete_references_and_age",
    "test_oversized_fragment_makes_finite_bounded_progress",
    "test_repeated_index_catchup_merges_small_segments",

  ]) {
    if (!proof.testCases.some(name => typeof name === "string" && (name === test || name.endsWith(`.${test}`)))) throw new Error(`Required native acceptance case absent: ${test}`);
  }
  const fault = JSON.parse(read(path.join(directory, "fault-acceptance.json"), 64 * 1024));
  if (fault.verdict !== "PASS_BOUNDED_NATIVE_FAULT_ACCEPTANCE" || fault.sourceDigest !== sourceSha256 ||
      fault.provenanceUnchanged !== true || !Number.isSafeInteger(fault.tests?.executed) || fault.tests.executed < 4 ||
      fault.tests?.passed !== fault.tests?.executed || fault.tests?.skipped !== 0 ||
      fault.tests?.failures !== 0 || fault.tests?.errors !== 0) throw new Error(`Native fault recovery acceptance incomplete: ${platform}`);
  for (const test of ["test_injected_backend_enospc_recovers_exact_owned_payloads_without_refund",
    "test_sigkill_after_first_owned_tag_delete_resumes_durable_finalization",
    "test_relocation_interruptions_preserve_each_valid_intermediate_head",
    "test_newer_orphan_and_partial_inventory_never_use_a_timestamp_cutoff"]) {
    if (!fault.testCases?.some(name => typeof name === "string" && (name === test || name.endsWith(`.${test}`)))) throw new Error(`Required native fault case absent: ${test}`);
  }
  const file = `gmax-bounded-maintenance-${platform}`;
  manifest.binaries[platform] = {file, sha256};
  acceptance.platforms[platform] = proof;
  acceptance.platforms[platform].faultRecovery = fault;
  verified.push([file, binary]);
  notices.push(`${platform}\n${"=".repeat(72)}\n${read(path.join(directory, "THIRD-PARTY-NOTICES.txt"), 8 * 1024**2).toString("utf8")}`);
}
fs.mkdirSync(output, {recursive: true});
for (const [file, binary] of verified) fs.writeFileSync(path.join(output, file), binary, {mode: 0o755});
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify(acceptance, null, 2) + "\n");
fs.writeFileSync(path.join(output, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));
console.log(`Assembled accepted native cleanup for ${Object.keys(manifest.binaries).join(", ")}`);

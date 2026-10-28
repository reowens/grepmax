# Fragment-bounded FTS release 0.26.103

This patch replaces whole-backlog FTS optimization with one explicit bounded
batch of pending whole fragments. Deleted rows count toward the unchanged
100,000 physical-row admission limit; live UTF-8 content is capped at 64 MiB.
The pinned Lance 12 API builds an uncommitted segment and publishes it with the
disjoint-segment commit API. Stored tokenizer settings and the newest existing
posting format are copied. Prior segments and immutable base/deletion/index
files, schema, configuration, tags, row counts and other indexes are verified.

Each invocation reports total `unindexedRows`, selected `batchRows` and
`selectedFragments`, and `remainingRows`. Completion means that batch finished;
a backlog may remain. Inspect the fresh head version before selecting another
run. An oversized first fragment is refused. There is no automatic multi-batch
retry, index merge, data compaction or version pruning. Old receipts remain
readable; completion still follows final exclusive-ownership verification.

The user explicitly authorized the retained focused invocation: 21 passed,
zero failed, one deliberately skipped (the prior 83,561-row regression). Six
native cases and 15 receipt/guard cases executed. 106,496 physical / 53,248 live
pending rows with deletions completed in two batches, 98,304 physical / 49,152
live then 8,192 physical / 4,096 live. Assertions preserved snapshots, sampled
row IDs, base hashes, another index and nondefault tokenizer behavior. Reduced
content-limit boundaries, interruption/reopen, uncertainty acknowledgement,
partial receipts and final ownership loss passed.

The invocation took 9.87 seconds and peaked at 640,131,072 bytes sampled owned
RSS under two CPUs, a 2 GiB group RSS guard and 120 seconds. All owned processes
closed and private fixtures were removed. These synthetic four-dimensional
Linux fixtures do not qualify production throughput or broader platforms.
Source/test typechecks and formatting passed; exact tested source hashes and
case/process results are retained in the linked evidence. Release preparation
reuses this evidence without another test invocation or model load.

[Source/scope receipt](assets/p3-cpu-20261027/fts-fragment-source-receipt.json),
[process receipt](assets/p3-cpu-20261027/fts-fragment-native-receipt.json), and
[case results](assets/p3-cpu-20261027/fts-fragment-native-tests.json).

Dependencies, model identities, native binaries and containment remain unchanged.
The release is prepared separately from P3 installation and production FTS
catch-up; the prior installation remains in service until an explicit handover.

## Single publication review and owner correction

The one static publication review of `ac8b184` found two blockers: normalized
manifest descriptions synthesize missing tokenizer defaults, and their
conversion drops custom stop-word lists. The owner correction reads each
segment's physical `metadata.lance` parameter JSON instead. Missing/incomplete,
unknown or differing parameter sets and legacy token-file layouts refuse
before admission. Metadata files are capped at 1 MiB and parameter JSON at
64 KiB. Only local plain-string row-document indexes are admitted.

The new segment is built from those physical parameters, including `null`
versus an explicit empty custom stop-word list. Its staged partition metadata
is compared before publishing, and committed physical metadata is compared
afterward. Existing batch, ownership and receipt control flow is retained.

Source build, test typecheck, Python syntax and formatting checks pass for the
correction. The user explicitly approved its targeted invocation: five native
cases passed, zero failed, six unselected cases skipped. Empty/nonempty custom
stop-word lists and missing physical parameter/tokenizer metadata are covered;
the two-batch case also passed through the corrected reader. The invocation
took 7.18 seconds and peaked at 673,677,312 bytes sampled owned-group RSS, with
all owned processes closed and private home/fixtures removed. The earlier
21-pass invocation remains historical evidence of its exact source; these
five cases establish the added coverage for the two findings. Both review
findings are resolved by the owner; no additional independent review is claimed
or required. The initial archive is retained under `reviewed-original` and must
not be published. Only the rebuilt corrected archive is the release candidate.

[Correction/source proof](assets/p3-cpu-20261027/fts-fragment-tokenizer-validation.json),
[correction process receipt](assets/p3-cpu-20261027/fts-fragment-tokenizer-receipt.json),
[correction cases](assets/p3-cpu-20261027/fts-fragment-tokenizer-tests.json), and
[single review disposition](assets/p3-cpu-20261027/fts-fragment-release-review.json).

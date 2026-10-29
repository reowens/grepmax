# Lance/discovery release preparation — October 29, 2026 UTC

Complete selected source/fixtures/docs from local commits47bccf5,4b414da,
dbdb188,a52476e,1f9a776 projected onto public0.26.108 records commit e806c32.
Root private history and unrelated ColBERT/resource prototypes are excluded.
SDK/native0.40.0/core13 and Python13; separate qualified Rust12 payload retained
unchanged under existing disabled full-table maintenance policy, not requalified
for core13 mutation. No Table-handle cleanup selected.

One focused native invocation: existing FTS check + two explicit stop-word
cases,128+32 temporary rows per case. Existing write cases gained stable row-ID,
path-index, engine-version and deterministic exact-vector assertions. Production
service-quarantine assertion is mocked only in the temporary native fixture;
real outer two-CPU/nice10,2GiB/180s/min8GiB/zero-swap guards and native helper
limits remain. Two-I/O-thread FTS configuration unchanged.3passed/8skipped,
1.908s, peak458,539,008bytes owned RSS, zero swap growth, no owned survivors and
empty temporary fixture directory. No model/production store/search quality call.

Final integration production typecheck reused:0.845s,339,361,792bytes RSS,
zero swap/no survivors. Selected production source is unchanged; this receipt
includes preserved root working-tree code, while the public checkout retains
previously shipped unrelated source and excludes the private refactor. Packaging
emits artifacts with TypeScript `--noCheck`; no second semantic typecheck/test.
The earlier swap-refusal receipt remains separately recorded. No broad audit,
review, profile, native Rust build or new qualification is added. Compatibility
is bounded to these three Linux temporary-data cases, not general quality/RSS
or all-platform certification. Publication/handover records follow separately.

---
type: doc
status: archived
created: 2026-06-28T22:06:11Z
updated: 2026-06-28T22:06:11Z
modules:
surfaces:
domain:
audience: internal
related_plans:
related_docs:
---

# Model Tier 384d Decision

> One-line summary of what this doc covers.

## Overview

## Model-tier decision — stay on small/384d (768d rejected)

> Extracted verbatim from the retired `NEXT.md` (2026-06-28). This is the
> durable record of the benchmarked tier decision; do not re-litigate without
> a fresh benchmark.

**Decision:** Do **not** switch `small`(384d) → `standard`(768d). 384d stays.

**Why (benchmarked, not on faith):** ran an isolated A/B on the gmax repo
(97 `src/eval.ts` cases, identical ~260-file corpus) under a throwaway `$HOME`
so the live daemon/MLX(:8100) and the shared 384d table were untouched. The
149M/768d "standard" model scored **~10 points worse on Recall@10** than the
47M/384d "small" model, consistently across every condition:

| Condition | small/384d R@10 | standard/768d R@10 | Δ |
|-----------|----------------|--------------------|---|
| MLX GPU, rerank ON (prod path) | 0.732 | 0.629 | −0.10 |
| MLX GPU, rerank OFF            | 0.722 | 0.619 | −0.10 |
| q4 ONNX CPU, rerank OFF        | 0.742 | 0.598 | −0.14 |

The first CPU run looked like it might be a q4-quantization artifact, so the
MLX (production GPU) follow-up was run to check — it **refuted** that: MLX vs q4
moved the numbers ≤0.02, and standard lost on both paths. The regression is
broad (11–13 of 97 cases fall out of the top-20 entirely), not a few outliers.
The bigger model genuinely underperforms on gmax's code-search cases.

**Cost avoided:** full re-embed of all 12 projects (platform alone = 144k
chunks), permanently slower indexing, more worker RAM, more storage — to *lose*
recall. No case for it.

**Residual caveat (doesn't change the call):** measured on gmax's own small
single-project corpus. A much larger/more diverse corpus *could* behave
differently, but there's no evidence pointing that way and the burden was on
standard to justify the cost. Revisit only if a concrete recall complaint
surfaces on a big repo — and benchmark again before switching.

**Operational note:** doctor still reports `schema_dim_ok=true` on 384d; the
index is healthy. The `gmax repair --rebuild` path (P0) is the sanctioned route
*if* a future dim change is ever decided.

## Remaining tier/dim follow-ups (open, non-urgent)

- **Optional hardening:** `repairRebuild` end-to-end integration test across a
  `small`→`standard` switch — currently covered only indirectly by the
  `getSchemaVectorDim` round-trip + the shared `reindexOneProject` regression.
- **Operational (not code):** after a release that touches daemon runtime,
  restart the long-running daemon to pick up the new binary —
  `pkill -x gmax-daemon && gmax watch --daemon -b`.

> The CI Node-20 follow-up that used to sit here is DONE (commits f9be979 +
> 7b64c86, 2026-06-28). The dim-change recovery path is `gmax repair --rebuild`
> (single source of truth `REBUILD_COMMAND`).

## Version History

- **2026-06-28T22:06:11Z** Created.

## Related Documentation


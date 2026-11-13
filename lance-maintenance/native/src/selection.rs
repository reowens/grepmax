//! Choose one bounded task from a metadata-only plan without a prefix budget.
//! Lance stops at the first oversized task when applying source quotas.
//! This selection does not authorize any native write.

#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    pub id: u64,
    pub source_bytes: u64,
    pub live_rows: usize,
    pub deleted_rows: usize,
    pub fragments: usize,
}

pub const AUTOMATIC_SOURCE_BYTES: u64 = 32 * 1024 * 1024;

/// A fragment relocation may take whole. `live_bytes` estimates its live rows'
/// payload from its data files.
#[derive(Clone, Copy, Debug)]
pub struct Source {
    pub id: u64,
    pub live_rows: usize,
    pub deleted_rows: usize,
    pub live_bytes: u64,
    pub uncovered_oversized: bool,
}

/// Small fragments, and fragments with deleted rows, merge whole into one
/// output, fewest live rows first. Fewer than 2 sources is no merge.
pub fn select_merge(
    sources: &[Source],
    small_bytes: u64,
    payload_bytes: u64,
    rows: usize,
    fragments: usize,
) -> Vec<u64> {
    let mut eligible: Vec<_> = sources
        .iter()
        .filter(|s| s.deleted_rows > 0 || s.live_bytes < small_bytes || s.uncovered_oversized)
        .collect();
    eligible.sort_by_key(|s| (s.live_rows, std::cmp::Reverse(s.deleted_rows), s.id));
    let (mut bytes, mut count, mut picked) = (0u64, 0usize, vec![]);
    for source in eligible {
        if picked.len() == fragments {
            break;
        }
        if bytes + source.live_bytes > payload_bytes || count + source.live_rows > rows {
            continue;
        }
        bytes += source.live_bytes;
        count += source.live_rows;
        picked.push(source.id);
    }
    if picked.len() < 2 {
        picked.clear();
    }
    picked
}

pub fn select_batch(
    candidates: &[Candidate],
    source_bytes: u64,
    rows: usize,
    fragments: usize,
) -> Option<u64> {
    candidates
        .iter()
        .filter(|candidate| {
            candidate.deleted_rows > 0
                && candidate.source_bytes <= source_bytes
                && candidate.live_rows <= rows
                && candidate.fragments <= fragments
        })
        .min_by_key(|candidate| {
            (
                std::cmp::Reverse(candidate.deleted_rows),
                candidate.source_bytes,
                candidate.id,
            )
        })
        .map(|candidate| candidate.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_first_fragment_cannot_starve_small_deleted_fragments() {
        let candidates = [
            Candidate {
                id: 1,
                source_bytes: 55_098_431,
                live_rows: 93,
                deleted_rows: 1530,
                fragments: 1,
            },
            Candidate {
                id: 2,
                source_bytes: 16_000,
                live_rows: 12,
                deleted_rows: 8,
                fragments: 1,
            },
            Candidate {
                id: 3,
                source_bytes: 8_000,
                live_rows: 20,
                deleted_rows: 5,
                fragments: 1,
            },
            Candidate {
                id: 4,
                source_bytes: 1,
                live_rows: 1,
                deleted_rows: 100,
                fragments: 65,
            },
        ];
        assert_eq!(
            select_batch(&candidates, AUTOMATIC_SOURCE_BYTES, 32768, 64),
            Some(2)
        );
    }

    #[test]
    fn row_and_byte_limits_apply_together_and_clean_fragments_are_excluded() {
        let candidates = [
            Candidate {
                id: 1,
                source_bytes: 1,
                live_rows: 2,
                deleted_rows: 0,
                fragments: 1,
            },
            Candidate {
                id: 2,
                source_bytes: 2,
                live_rows: 32769,
                deleted_rows: 1,
                fragments: 1,
            },
            Candidate {
                id: 3,
                source_bytes: AUTOMATIC_SOURCE_BYTES + 1,
                live_rows: 1,
                deleted_rows: 1,
                fragments: 1,
            },
        ];
        assert_eq!(
            select_batch(&candidates, AUTOMATIC_SOURCE_BYTES, 32768, 64),
            None
        );
        assert_eq!(select_batch(&[], AUTOMATIC_SOURCE_BYTES, 32768, 64), None);
    }

    #[test]
    fn exact_limits_are_allowed_and_caller_can_lower_source_allowance() {
        let candidates = [Candidate {
            id: 1,
            source_bytes: AUTOMATIC_SOURCE_BYTES,
            live_rows: 32768,
            deleted_rows: 1,
            fragments: 64,
        }];
        assert_eq!(
            select_batch(&candidates, AUTOMATIC_SOURCE_BYTES, 32768, 64),
            Some(1)
        );
        assert_eq!(
            select_batch(&candidates, AUTOMATIC_SOURCE_BYTES - 1, 32768, 64),
            None
        );
    }

    fn source(id: u64, live_rows: usize, deleted_rows: usize, live_bytes: u64) -> Source {
        Source {
            id,
            live_rows,
            deleted_rows,
            live_bytes,
            uncovered_oversized: false,
        }
    }

    #[test]
    fn merge_takes_the_fewest_live_rows_that_fit_and_leaves_full_fragments() {
        let sources = [
            source(1, 700, 0, 16_000),
            source(2, 30, 0, 600),
            source(3, 0, 12, 0),
            source(4, 30, 5, 600),
            source(5, 400, 0, 9_000),
            source(6, 500, 0, 7_000),
        ];
        // 1 and 5 are full and clean; 6 is small but no longer fits.
        assert_eq!(select_merge(&sources, 8_000, 8_000, 1024, 64), vec![3, 4, 2]);
        assert_eq!(select_merge(&sources, 8_000, 20_000, 1024, 64), vec![3, 4, 2, 6]);
        assert_eq!(select_merge(&sources, 8_000, 8_000, 1024, 2), vec![3, 4]);
        assert_eq!(select_merge(&sources, 8_000, 8_000, 40, 64), vec![3, 4]);
    }

    #[test]
    fn merge_needs_two_sources_and_takes_uncovered_oversized_ones() {
        let lone = [source(1, 10, 0, 100), source(2, 900, 0, 20_000)];
        assert!(select_merge(&lone, 8_000, 12_000, 1024, 64).is_empty());
        let mut uncovered = source(2, 400, 0, 9_000);
        uncovered.uncovered_oversized = true;
        assert_eq!(
            select_merge(&[lone[0], uncovered], 8_000, 12_000, 1024, 64),
            vec![1, 2]
        );
        // A fragment with deletions too large to take whole is left to the
        // partial drain.
        assert!(select_merge(&[lone[0], source(3, 900, 1, 20_000)], 8_000, 12_000, 1024, 64).is_empty());
    }

    #[test]
    fn equal_size_choice_is_deterministic_in_any_manifest_order() {
        let candidates = [
            Candidate {
                id: 4,
                source_bytes: 100,
                live_rows: 4,
                deleted_rows: 1,
                fragments: 1,
            },
            Candidate {
                id: 2,
                source_bytes: 100,
                live_rows: 4,
                deleted_rows: 1,
                fragments: 1,
            },
        ];
        assert_eq!(select_batch(&candidates, 100, 4, 64), Some(2));
        assert_eq!(
            select_batch(&[candidates[1], candidates[0]], 100, 4, 64),
            Some(2)
        );
    }
}

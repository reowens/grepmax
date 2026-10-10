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

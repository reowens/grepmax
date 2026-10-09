use gmax_bounded_maintenance::meter::{FINALIZATION_RECORD_RESERVE, Ledger, MAX_JOURNAL_RECORDS};
use object_store::path::Path;
use sha2::{Digest, Sha256};
use std::{fs, io::Write};

fn valid_journal(path: &std::path::Path, records: u64, cap: u64) {
    let mut file = std::io::BufWriter::new(fs::File::create(path).unwrap());
    for record in 1..=records {
        let total = record * 80;
        let mut bytes = Vec::with_capacity(80);
        for number in [cap, total, 0, 0, total, 0] {
            bytes.extend_from_slice(&number.to_le_bytes());
        }
        let checksum = Sha256::digest(&bytes);
        bytes.extend_from_slice(&checksum);
        file.write_all(&bytes).unwrap();
    }
    file.flush().unwrap();
}

#[test]
fn permitted_stream_cannot_create_an_unrestorable_journal() {
    let home = tempfile::tempdir().unwrap();
    let cap = 64 * 1024 * 1024;
    let file = home.path().join("ordinary.journal");
    let ordinary = MAX_JOURNAL_RECORDS - FINALIZATION_RECORD_RESERVE;
    valid_journal(&file, ordinary, cap);
    let ledger = Ledger::restore(cap, &file)
        .unwrap()
        .with_finalization_reserve(512 * 1024)
        .with_finalization_paths(vec![Path::from("table/_gmax-bounded-receipt.json")]);
    let counts = ledger.counts();
    assert!(
        ledger
            .charge(&Path::from("table/data/copy.lance"), 1)
            .is_err()
    );
    assert_eq!(
        ledger.counts().total_bytes_written,
        counts.total_bytes_written
    );
    assert_eq!(fs::metadata(&file).unwrap().len(), ordinary * 80);
    ledger.enter_metadata_finalization().unwrap();
    ledger
        .charge(&Path::from("table/_gmax-bounded-receipt.json"), 0)
        .unwrap();
    drop(ledger);
    assert!(Ledger::restore(cap, &file).is_ok());

    let final_file = home.path().join("final.journal");
    valid_journal(&final_file, MAX_JOURNAL_RECORDS, cap);
    let final_ledger = Ledger::restore(cap, &final_file).unwrap();
    final_ledger.enter_metadata_finalization().unwrap();
    assert!(
        final_ledger
            .charge(&Path::from("_gmax-maintenance/journal"), 0)
            .is_err()
    );
    assert_eq!(
        fs::metadata(final_file).unwrap().len(),
        MAX_JOURNAL_RECORDS * 80
    );
}

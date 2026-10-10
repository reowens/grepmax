use gmax_bounded_maintenance::meter::{Ledger, MeteredStore, SourceReads};
use object_store::{ObjectStoreExt, local::LocalFileSystem, path::Path};
use std::sync::Arc;
#[tokio::test]
async fn submitted_ranges_and_recovery_share_a_non_refunding_allowance() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("table/data")).unwrap();
    std::fs::write(home.path().join("table/data/input.lance"), b"0123456789").unwrap();
    let ledger = Arc::new(Ledger::with_journal(4096, &home.path().join("writes")).unwrap());
    let log = home.path().join("reads");
    let reads = Arc::new(SourceReads::journal(8, &log, ledger.clone(), false).unwrap());
    let store = MeteredStore::new(
        Arc::new(LocalFileSystem::new_with_prefix(home.path()).unwrap()),
        ledger.clone(),
        Path::from("table"),
    )
    .with_source_reads(reads.clone());
    let path = Path::from("table/data/input.lance");
    assert_eq!(store.head(&path).await.unwrap().size, 10);
    assert_eq!(reads.used(), 0);
    assert_eq!(
        store.get_range(&path, 0..4).await.unwrap().as_ref(),
        b"0123"
    );
    assert_eq!(
        store.get_range(&path, 0..4).await.unwrap().as_ref(),
        b"0123"
    );
    assert_eq!(reads.used(), 8);
    assert!(store.get_range(&path, 4..5).await.is_err());
    let written = ledger.counts().total_bytes_written;
    assert!(written > 80);
    drop(store);
    drop(reads);
    let restored = Arc::new(SourceReads::journal(8, &log, ledger, true).unwrap());
    assert_eq!(restored.used(), 8);
    assert!(restored.charge(1).is_err());
    drop(restored);
    std::fs::write(&log, b"torn").unwrap();
    assert!(SourceReads::journal(8, &log, Arc::new(Ledger::new(4096).unwrap()), true).is_err());
    assert_eq!(std::fs::read(&log).unwrap(), b"torn");
}
#[tokio::test]
async fn vector_ranges_and_full_get_cannot_bypass_the_meter() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("table/data")).unwrap();
    std::fs::write(home.path().join("table/data/input.lance"), b"0123456789").unwrap();
    let reads = Arc::new(SourceReads::new(8));
    let store = MeteredStore::new(
        Arc::new(LocalFileSystem::new_with_prefix(home.path()).unwrap()),
        Arc::new(Ledger::new(4096).unwrap()),
        Path::from("table"),
    )
    .with_source_reads(reads.clone());
    let path = Path::from("table/data/input.lance");
    assert_eq!(
        store.get_ranges(&path, &[0..4, 4..8]).await.unwrap().len(),
        2
    );
    assert_eq!(reads.used(), 8);
    assert!(store.get(&path).await.is_err());
    assert_eq!(reads.used(), 8);
}

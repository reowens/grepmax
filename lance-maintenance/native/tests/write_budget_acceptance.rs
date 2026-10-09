//! Independent tests against the public meter and pinned local filesystem.
//! These prove attempted payload accounting, not physical filesystem writes.
use std::sync::Arc;

use gmax_bounded_maintenance::meter::{Ledger, MeteredStore, free_bytes};
use object_store::{
    ObjectStore, ObjectStoreExt, PutMode, PutOptions, local::LocalFileSystem, path::Path,
};

fn fixture(cap: u64) -> (tempfile::TempDir, Arc<Ledger>, Arc<MeteredStore>) {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("table")).unwrap();
    let inner = Arc::new(LocalFileSystem::new_with_prefix(home.path()).unwrap());
    let ledger = Arc::new(Ledger::new(cap).unwrap());
    let store = Arc::new(MeteredStore::new(
        inner,
        ledger.clone(),
        Path::from("table"),
    ));
    (home, ledger, store)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_attempts_never_cross_shared_cap() {
    let (home, ledger, store) = fixture(16);
    let mut work = Vec::new();
    for n in 0..32 {
        let store = store.clone();
        work.push(tokio::spawn(async move {
            store
                .put(&Path::from(format!("table/data/{n}.bin")), "abc".into())
                .await
                .is_ok()
        }));
    }
    let mut completed = 0;
    for task in work {
        completed += usize::from(task.await.unwrap());
    }
    assert_eq!(completed, 5);
    assert_eq!(ledger.counts().total_bytes_written, 15);
    assert_eq!(ledger.counts().data_bytes_written, 15);
    assert_eq!(
        std::fs::read_dir(home.path().join("table/data"))
            .unwrap()
            .count(),
        5
    );
}

#[tokio::test]
async fn failed_conditional_put_stays_charged_and_denial_precedes_write() {
    let (home, ledger, store) = fixture(7);
    let file = Path::from("table/_versions/original");
    store.put(&file, "abc".into()).await.unwrap();
    assert!(
        store
            .put_opts(
                &file,
                "def".into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.counts().total_bytes_written, 6);
    assert!(
        store
            .put(&Path::from("table/_versions/denied"), "ghi".into())
            .await
            .is_err()
    );
    assert_eq!(ledger.counts().total_bytes_written, 6);
    assert_eq!(
        std::fs::read(home.path().join("table/_versions/original")).unwrap(),
        b"abc"
    );
    assert!(!home.path().join("table/_versions/denied").exists());
}

#[tokio::test]
async fn multipart_denial_cannot_publish_a_partial_upload() {
    let (home, ledger, store) = fixture(6);
    let file = Path::from("table/_indices/partial");
    let mut upload = store.put_multipart(&file).await.unwrap();
    upload.put_part("abcd".into()).await.unwrap();
    assert!(upload.put_part("efg".into()).await.is_err());
    assert!(upload.complete().await.is_err());
    assert!(upload.put_part("z".into()).await.is_err());
    assert_eq!(ledger.counts().total_bytes_written, 4);
    assert_eq!(ledger.counts().index_bytes_written, 4);
    assert!(!home.path().join("table/_indices/partial").exists());
    upload.abort().await.unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 4);
}

#[tokio::test]
async fn local_copy_and_rename_are_conservatively_charged_before_mutation() {
    let (home, ledger, store) = fixture(9);
    let first = Path::from("table/data/first");
    let copied = Path::from("table/data/copied");
    let renamed = Path::from("table/data/renamed");
    store.put(&first, "abc".into()).await.unwrap();
    store.copy(&first, &copied).await.unwrap();
    store.rename(&copied, &renamed).await.unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 9);
    assert!(
        store
            .rename(&first, &Path::from("table/data/denied"))
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(home.path().join("table/data/first")).unwrap(),
        b"abc"
    );
    assert_eq!(
        std::fs::read(home.path().join("table/data/renamed")).unwrap(),
        b"abc"
    );
    assert!(!home.path().join("table/data/denied").exists());
}

#[tokio::test]
async fn escaping_root_is_refused_without_charging_or_creating_files() {
    let (home, ledger, store) = fixture(16);
    assert!(
        store
            .put(&Path::from("table-other/escaped"), "abc".into())
            .await
            .is_err()
    );
    assert!(
        store
            .put_multipart(&Path::from("outside/upload"))
            .await
            .is_err()
    );
    assert_eq!(ledger.counts().total_bytes_written, 0);
    assert!(!home.path().join("table-other").exists());
    assert!(!home.path().join("outside").exists());
}

#[test]
fn cap_and_counter_overflow_are_refused_without_resetting_charge() {
    assert!(Ledger::new(0).is_err());
    assert!(Ledger::new(512 * 1024 * 1024 + 1).is_err());
    let ledger = Ledger::new(16).unwrap();
    let path = Path::from("table/data/file");
    ledger.charge(&path, 1).unwrap();
    assert!(ledger.charge(&path, u64::MAX).is_err());
    assert_eq!(ledger.counts().total_bytes_written, 1);
    ledger.charge(&path, 15).unwrap();
    assert!(ledger.charge(&path, 1).is_err());
    assert_eq!(ledger.counts().total_bytes_written, 16);
}

#[test]
fn durable_charge_counts_its_own_records_and_never_resets_after_restore() {
    let home = tempfile::tempdir().unwrap();
    let journal = home.path().join("attempt.journal");
    let ledger = Ledger::with_journal(250, &journal).unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 80);
    ledger.charge(&Path::from("table/data/file"), 10).unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 170);
    assert_eq!(ledger.counts().data_bytes_written, 10);
    assert_eq!(ledger.counts().metadata_bytes_written, 160);
    assert_eq!(std::fs::metadata(&journal).unwrap().len(), 160);
    drop(ledger);
    let restored = Ledger::restore(250, &journal).unwrap();
    assert_eq!(restored.counts().total_bytes_written, 170);
    assert!(
        restored
            .charge(&Path::from("table/data/denied"), 1)
            .is_err()
    );
    assert_eq!(std::fs::metadata(&journal).unwrap().len(), 160);
    restored
        .charge(&Path::from("table/_versions/metadata"), 0)
        .unwrap();
    assert_eq!(restored.counts().total_bytes_written, 250);
    assert_eq!(std::fs::metadata(&journal).unwrap().len(), 240);
    drop(restored);
    assert_eq!(
        Ledger::restore(250, &journal)
            .unwrap()
            .counts()
            .total_bytes_written,
        250
    );
}

#[test]
fn torn_corrupt_and_different_cap_journals_are_refused_without_recreation() {
    let home = tempfile::tempdir().unwrap();
    let journal = home.path().join("attempt.journal");
    drop(Ledger::with_journal(1024, &journal).unwrap());
    let original = std::fs::read(&journal).unwrap();
    assert!(Ledger::restore(1025, &journal).is_err());
    assert_eq!(std::fs::read(&journal).unwrap(), original);
    for damaged in [
        original[..79].to_vec(),
        {
            let mut changed = original.clone();
            changed[48] ^= 1;
            changed
        },
        Vec::new(),
    ] {
        std::fs::write(&journal, &damaged).unwrap();
        assert!(Ledger::restore(1024, &journal).is_err());
        assert!(Ledger::with_journal(1024, &journal).is_err());
        assert_eq!(std::fs::read(&journal).unwrap(), damaged);
    }
}

#[tokio::test]
async fn insufficient_fresh_space_refuses_before_charge_or_payload_creation() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("table")).unwrap();
    let free = free_bytes(home.path()).unwrap();
    let ledger = Arc::new(
        Ledger::new(1024)
            .unwrap()
            .with_space_guard(home.path().to_path_buf(), free + 1024 * 1024 * 1024),
    );
    let inner = Arc::new(LocalFileSystem::new_with_prefix(home.path()).unwrap());
    let store = MeteredStore::new(inner, ledger.clone(), Path::from("table"));
    assert!(
        store
            .put(&Path::from("table/data/refused"), "abc".into())
            .await
            .is_err()
    );
    assert_eq!(ledger.counts().total_bytes_written, 0);
    assert!(!home.path().join("table/data").exists());
}

#[test]
fn ordinary_writes_cannot_spend_metadata_finalization_reserve() {
    let home = tempfile::tempdir().unwrap();
    let journal = home.path().join("attempt.journal");
    let ledger = Ledger::with_journal(400, &journal)
        .unwrap()
        .with_finalization_reserve(100)
        .with_finalization_paths(vec![Path::from("table/_gmax-bounded-receipt.json")]);
    ledger.charge(&Path::from("table/data/file"), 140).unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 300);
    assert!(ledger.charge(&Path::from("table/data/file"), 1).is_err());
    ledger.enter_metadata_finalization().unwrap();
    assert!(ledger.charge(&Path::from("table/data/file"), 1).is_err());
    assert!(
        ledger
            .charge(&Path::from("table/_versions/manifest"), 1)
            .is_err()
    );
    assert!(
        ledger
            .charge(&Path::from("table/data/_gmax-bounded-receipt.json"), 1)
            .is_err()
    );
    ledger
        .charge(&Path::from("table/_gmax-bounded-receipt.json"), 20)
        .unwrap();
    assert_eq!(ledger.counts().total_bytes_written, 400);
    assert_eq!(ledger.counts().data_bytes_written, 140);
    assert_eq!(ledger.counts().metadata_bytes_written, 260);
}

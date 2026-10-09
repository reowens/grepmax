use gmax_bounded_maintenance::{meter::Ledger, owned::OwnedWrites};
use object_store::path::Path;
use std::{fs, sync::Arc};
use tempfile::tempdir;

#[test]
fn owned_log_restores_only_attempt_targets_and_numeric_staging() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("table.lance");
    fs::create_dir_all(root.join("data")).unwrap();
    let ledger = Arc::new(Ledger::with_journal(4 * 1024 * 1024, &root.join("ledger")).unwrap());
    let path = Path::from_absolute_path(root.join("data/new.lance")).unwrap();
    let owned = OwnedWrites::create(ledger.clone(), root.clone(), "owned.jsonl").unwrap();
    owned.register(&path).unwrap();
    fs::write(root.join("data/new.lance"), b"partial").unwrap();
    fs::write(root.join("data/new.lance#1"), b"staging").unwrap();
    fs::write(root.join("data/new.lance#unknown"), b"unknown").unwrap();
    fs::write(root.join("data/unrelated.lance"), b"unrelated").unwrap();
    drop(owned);
    drop(ledger);
    let restored = Arc::new(Ledger::restore(4 * 1024 * 1024, &root.join("ledger")).unwrap());
    let owned = OwnedWrites::restore(restored.clone(), root.clone(), "owned.jsonl").unwrap();
    restored.enter_metadata_finalization().unwrap();
    assert_eq!(owned.cleanup_proven_abort().unwrap(), 2);
    assert!(root.join("data/new.lance#unknown").exists());
    assert!(root.join("data/unrelated.lance").exists());
    assert_eq!(owned.cleanup_proven_abort().unwrap(), 0);
}

#[test]
fn initial_absence_includes_staging_and_live_payloads() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("table.lance");
    fs::create_dir_all(root.join("data")).unwrap();
    let ledger = Arc::new(Ledger::new(4 * 1024 * 1024).unwrap());
    let owned = OwnedWrites::create(ledger.clone(), root.clone(), "owned.jsonl").unwrap();
    let baseline = ledger.counts().total_bytes_written;
    fs::write(root.join("data/preexisting.lance"), b"live").unwrap();
    fs::write(root.join("data/staged.lance#2"), b"prior").unwrap();
    assert!(
        owned
            .register(&Path::from_absolute_path(root.join("data/preexisting.lance")).unwrap())
            .is_err()
    );
    assert!(
        owned
            .register(&Path::from_absolute_path(root.join("data/staged.lance")).unwrap())
            .is_err()
    );
    assert_eq!(ledger.counts().total_bytes_written, baseline);
    assert!(
        owned
            .check_rename_source(
                &Path::from_absolute_path(root.join("data/preexisting.lance")).unwrap()
            )
            .is_err()
    );
}

#[test]
fn torn_ownership_log_never_guesses_or_removes_payloads() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("table.lance");
    fs::create_dir_all(root.join("data")).unwrap();
    let ledger = Arc::new(Ledger::new(4 * 1024 * 1024).unwrap());
    let owned = OwnedWrites::create(ledger.clone(), root.clone(), "owned.jsonl").unwrap();
    owned
        .register(&Path::from_absolute_path(root.join("data/new.lance")).unwrap())
        .unwrap();
    drop(owned);
    let bytes = fs::read(root.join("owned.jsonl")).unwrap();
    fs::write(root.join("owned.jsonl"), &bytes[..bytes.len() - 1]).unwrap();
    assert!(OwnedWrites::restore(ledger, root.clone(), "owned.jsonl").is_err());
}

#[cfg(unix)]
#[test]
fn cleanup_refuses_symlink_substitution_before_any_unlink() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("table.lance");
    fs::create_dir_all(root.join("data")).unwrap();
    let ledger = Arc::new(Ledger::new(4 * 1024 * 1024).unwrap());
    let owned = OwnedWrites::create(ledger.clone(), root.clone(), "owned.jsonl").unwrap();
    let first = root.join("data/a.lance");
    let second = root.join("data/z.lance");
    owned
        .register(&Path::from_absolute_path(&first).unwrap())
        .unwrap();
    owned
        .register(&Path::from_absolute_path(&second).unwrap())
        .unwrap();
    fs::write(&first, b"owned").unwrap();
    std::os::unix::fs::symlink(&first, &second).unwrap();
    ledger.enter_metadata_finalization().unwrap();
    assert!(owned.cleanup_proven_abort().is_err());
    assert!(first.exists());
    assert!(
        fs::symlink_metadata(second)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

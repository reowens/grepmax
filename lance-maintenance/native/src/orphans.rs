//! Resumable metadata-only reference closure. Partial inventories never delete.
use crate::engine::{
    Receipt, Request, all_indices, fingerprint, object_root, save_receipt, verify_owner,
};
use crate::meter::Ledger;
use anyhow::{Context, Result, ensure};
use lance::Dataset;
use lance_table::io::deletion::relative_deletion_file_path;
use object_store::{ObjectStoreExt, path::Path as ObjectPath};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
const INVENTORY: &str = "_gmax-reference-inventory.json";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const PER_UNIT: usize = 32;
const MAX_VERSIONS: usize = 32768;
const MAX_OBJECTS: usize = 100000;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub path: String,
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
    pub modified: i64,
    pub modified_nsec: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub complete: bool,
    pub versions_scanned: usize,
    pub versions_remaining: usize,
    pub candidates: Vec<Identity>,
    pub reclaimed: usize,
}
impl Proof {
    pub fn valid(&self) -> bool {
        self.candidates.len() <= 64
            && self.reclaimed <= self.candidates.len()
            && self.versions_scanned <= MAX_VERSIONS
            && self.versions_remaining <= MAX_VERSIONS
            && (self.complete || self.candidates.is_empty())
            && self.candidates.iter().all(|f| safe_payload(&f.path))
    }
}
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    schema_version: u32,
    scanned: BTreeSet<u64>,
    references: BTreeSet<String>,
    complete: bool,
    completed_at: u64,
    checksum: String,
}
fn hash(state: &Inventory) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &state.schema_version,
                &state.scanned,
                &state.references,
                state.complete,
                state.completed_at
            ))
            .unwrap()
        )
    )
}
fn load(root: &Path) -> Result<Option<Inventory>> {
    let path = root.join(INVENTORY);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path)?;
    ensure!(
        meta.is_file() && meta.nlink() == 1 && meta.len() <= MAX_BYTES as u64,
        "Reference inventory file bound"
    );
    let state: Inventory = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        state.schema_version == 1
            && state.scanned.len() <= MAX_VERSIONS
            && state.references.len() <= MAX_OBJECTS
            && state.checksum == hash(&state),
        "Reference inventory proof invalid"
    );
    Ok(Some(state))
}
fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
fn safe_payload(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return false;
    }
    match parts.as_slice() {
        ["data", filename] => filename.ends_with(".lance"),
        ["_deletions", filename] => filename.ends_with(".arrow") || filename.ends_with(".bin"),
        ["_indices", uuid, rest @ ..] => uuid::Uuid::parse_str(uuid).is_ok() && !rest.is_empty(),
        _ => false,
    }
}
pub fn plan(root: &Path) -> Result<Option<crate::repair::Proof>> {
    if load(root)?.is_some_and(|state| {
        state.complete && now().is_ok_and(|n| n.saturating_sub(state.completed_at) < 300)
    }) {
        return Ok(None);
    }
    Ok(Some(crate::repair::Proof {
        fragments: vec![],
        name: String::new(),
        field: String::new(),
        merge: vec![],
        output: None,
        relocation: None,
        orphans: Some(Proof::default()),
    }))
}
pub async fn execute(
    dataset: &Dataset,
    root: &Path,
    receipt: &mut Receipt,
    request: &Request,
    ledger: &Arc<Ledger>,
) -> Result<()> {
    // Branches, detached staging heads, overlays, external bases and unknown
    // operation owners cannot be converted into an absence-of-reference claim.
    ensure!(
        dataset.list_branches().await?.is_empty()
            && dataset.list_detached_manifests().await?.is_empty(),
        "External/detached ownership prevents orphan reclamation"
    );
    let mut state = load(root)?.filter(|s| !s.complete).unwrap_or(Inventory {
        schema_version: 1,
        ..Default::default()
    });
    let mut versions: BTreeSet<_> = dataset
        .version_refs()
        .await?
        .iter()
        .map(|v| v.version)
        .collect();
    versions.extend(receipt.original_tags.values().copied());
    versions.insert(receipt.before_version);
    ensure!(
        versions.len() <= MAX_VERSIONS && versions.iter().all(|v| *v > 0 && *v < (1 << 63)),
        "Retained version inventory bound"
    );
    let pending: Vec<_> = versions.difference(&state.scanned).copied().collect();
    for version in pending.iter().take(PER_UNIT) {
        let snapshot = dataset.checkout_version(*version).await?;
        ensure!(
            snapshot.manifest.base_paths.is_empty(),
            "External base in retained snapshot"
        );
        for f in snapshot.manifest.fragments.iter() {
            ensure!(
                f.overlays.is_empty(),
                "Retained overlay reference unsupported"
            );
            for file in &f.files {
                ensure!(
                    file.base_id.is_none() && !file.path.contains('/'),
                    "Retained external data reference"
                );
                state.references.insert(format!("data/{}", file.path));
            }
            if let Some(deletion) = &f.deletion_file {
                ensure!(
                    deletion.base_id.is_none(),
                    "Retained external deletion reference"
                );
                state
                    .references
                    .insert(relative_deletion_file_path(f.id, deletion));
            }
        }
        for index in all_indices(&snapshot).await? {
            ensure!(index.base_id.is_none(), "Retained external index reference");
            state.references.insert(format!("_indices/{}/", index.uuid));
        }
        state.scanned.insert(*version);
        ensure!(
            state.scanned.len() <= MAX_VERSIONS && state.references.len() <= MAX_OBJECTS,
            "Reference closure bound"
        );
    }
    let remaining = versions.difference(&state.scanned).count();
    state.complete = remaining == 0;
    if state.complete {
        state.completed_at = now()?;
    }
    state.checksum = hash(&state);
    let bytes = serde_json::to_vec(&state)?;
    ensure!(bytes.len() <= MAX_BYTES, "Reference cursor byte bound");
    dataset
        .object_store(None)
        .await?
        .inner
        .put(&object_root(root)?.child(INVENTORY), bytes.into())
        .await?;
    {
        let proof = receipt.repair.as_mut().unwrap().orphans.as_mut().unwrap();
        proof.complete = state.complete;
        proof.versions_scanned = state.scanned.len();
        proof.versions_remaining = remaining;
    }
    save_receipt(dataset, root, receipt).await?;
    if !state.complete {
        return Ok(());
    }
    let mut todo = vec![
        root.join("data"),
        root.join("_indices"),
        root.join("_deletions"),
    ];
    let mut count = 0;
    let mut candidates = vec![];
    while let Some(path) = todo.pop() {
        if !path.exists() {
            continue;
        }
        count += 1;
        ensure!(count <= MAX_OBJECTS, "Orphan candidate inventory truncated");
        let meta = fs::symlink_metadata(&path)?;
        ensure!(
            !meta.file_type().is_symlink(),
            "Symlink candidate inventory"
        );
        if meta.is_dir() {
            for entry in fs::read_dir(&path)? {
                todo.push(entry?.path());
            }
            continue;
        }
        ensure!(
            meta.is_file() && meta.nlink() == 1,
            "Externally linked orphan candidate"
        );
        let relative = path
            .strip_prefix(root)?
            .to_str()
            .context("Non-UTF8 orphan path")?;
        if !safe_payload(relative)
            || state.references.contains(relative)
            || state
                .references
                .iter()
                .filter(|p| p.ends_with('/'))
                .any(|p| relative.starts_with(p))
        {
            continue;
        }
        if now()?.saturating_sub(meta.mtime().max(0) as u64) < 120 {
            continue;
        }
        // Candidate selection is bounded, but the enumeration must complete:
        // exceeding its bound is never a complete proof.
        if candidates.len() < 64 {
            candidates.push(Identity {
                path: relative.into(),
                device: meta.dev(),
                inode: meta.ino(),
                bytes: meta.len(),
                modified: meta.mtime(),
                modified_nsec: meta.mtime_nsec(),
            });
        }
    }
    receipt
        .repair
        .as_mut()
        .unwrap()
        .orphans
        .as_mut()
        .unwrap()
        .candidates = candidates.clone();
    save_receipt(dataset, root, receipt).await?;
    verify_owner(request, root, false)?;
    ensure!(
        dataset.latest_version_id().await? == receipt.before_version
            && fingerprint(dataset).await? == receipt.before_fingerprint,
        "Reference inventory head changed"
    );
    ensure!(
        dataset
            .tags()
            .list()
            .await?
            .iter()
            .filter(|(name, _)| *name != &receipt.reader_tag)
            .all(|(name, tag)| receipt.original_tags.get(name) == Some(&tag.version)),
        "Reference inventory tags changed"
    );
    let fresh: BTreeSet<_> = dataset
        .version_refs()
        .await?
        .iter()
        .map(|v| v.version)
        .collect();
    ensure!(
        fresh.is_subset(&state.scanned),
        "Reference inventory invalidated by new version"
    );
    for candidate in candidates {
        verify_owner(request, root, false)?;
        let path = root.join(&candidate.path);
        let meta = fs::symlink_metadata(&path)?;
        ensure!(
            meta.is_file()
                && meta.nlink() == 1
                && meta.dev() == candidate.device
                && meta.ino() == candidate.inode
                && meta.len() == candidate.bytes
                && meta.mtime() == candidate.modified
                && meta.mtime_nsec() == candidate.modified_nsec,
            "Orphan identity changed before delete"
        );
        ledger.charge(&ObjectPath::from("_gmax-maintenance/journal"), 0)?;
        fs::remove_file(&path)?;
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        receipt
            .repair
            .as_mut()
            .unwrap()
            .orphans
            .as_mut()
            .unwrap()
            .reclaimed += 1;
    }
    save_receipt(dataset, root, receipt).await?;
    Ok(())
}
pub async fn verify(before: &Dataset, after: &Dataset, receipt: &Receipt) -> Result<usize> {
    ensure!(
        fingerprint(before).await? == fingerprint(after).await?
            && before.version_id() == receipt.before_version,
        "Reclamation changed logical data/index state"
    );
    Ok(0)
}

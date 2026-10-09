//! Pinned Lance execution through a metered, durable local object store.
//! Source and lifecycle qualification are implemented here, never in Python.
use crate::meter::{Counts, Ledger, MeteredStore, free_bytes};
use crate::owned::OwnedWrites;
use anyhow::{Context, Result, anyhow, bail, ensure};
use arrow_row::{RowConverter, SortField};
use arrow_schema::Schema as ArrowSchema;
use futures::TryStreamExt;
use lance::{
    Dataset,
    dataset::{
        builder::DatasetBuilder,
        index::DatasetIndexRemapperOptions,
        optimize::{CompactionMode, CompactionOptions, commit_compaction, plan_compaction},
    },
    index::{DatasetIndexExt, DatasetIndexInternalExt},
};
use lance_index::{IndexType, metrics::NoOpMetricsCollector, scalar::inverted::InvertedIndex};
use lance_io::object_store::{ObjectStoreParams, WrappingObjectStore};
use lance_table::{
    format::{Fragment, IndexMetadata},
    io::manifest::read_manifest_indexes,
};
use object_store::{ObjectStore, ObjectStoreExt, local::LocalFileSystem, path::Path};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, Read, Write},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

const MAX_SOURCE: u64 = 512 * 1024 * 1024;
const MAX_ROWS: usize = 32768;
const MAX_FRAGMENTS: usize = 64;
const RECEIPT: &str = "_gmax-bounded-receipt.json";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
#[derive(Debug)]
pub struct ReportedError(pub String);
impl std::fmt::Display for ReportedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for ReportedError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub action: String,
    pub store: PathBuf,
    pub expected_version: u64,
    pub total_write_budget_bytes: u64,
    pub free_space_margin_bytes: u64,
    pub lease_owner: PathBuf,
    pub lease_nonce: String,
    #[serde(default = "source_default")]
    pub source_limit_bytes: u64,
    #[serde(default)]
    pub selected_fragment_ids: Option<Vec<u64>>,
    #[cfg(feature = "qualification")]
    #[serde(default)]
    pub qualification_fail_path_prefix: Option<String>,
    #[cfg(feature = "qualification")]
    #[serde(default)]
    pub qualification_pause_after_first_tag_delete: bool,
}
fn source_default() -> u64 {
    MAX_SOURCE
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    protocol_version: u32,
    phase: String,
    receipt_id: String,
    plan_id: String,
    before_version: u64,
    after_version: Option<u64>,
    verified_copy_version: Option<u64>,
    selected_fragment_ids: Vec<u64>,
    reader_tag: String,
    after_tag: String,
    original_tags: BTreeMap<String, u64>,
    journal: String,
    owned_writes: String,
    total_write_budget_bytes: u64,
    source_bytes: u64,
    source_rows_digest: String,
    rows_verified: usize,
    before_fingerprint: String,
    accepted_fingerprint: Option<String>,
    helper_pid: u32,
    helper_start: String,
    aborted: bool,
    abort_proven: bool,
    finalization_reserve_bytes: u64,
    retired_metadata: Vec<String>,
}

#[derive(Debug)]
struct Wrapper {
    ledger: Arc<Ledger>,
    root: Path,
    delete_paths: Vec<Path>,
    owned: Option<Arc<OwnedWrites>>,
    #[cfg(feature = "qualification")]
    failure_prefix: Option<String>,
}
impl WrappingObjectStore for Wrapper {
    fn wrap(&self, prefix: &str, original: Arc<dyn ObjectStore>) -> Arc<dyn ObjectStore> {
        // Reject unexpected stores, instead of accidentally permitting direct
        // local-writer routes or an external blob/index store.
        assert_eq!(prefix, "file-object-store", "Unexpected store provider");
        let mut wrapped = MeteredStore::new(original, self.ledger.clone(), self.root.clone())
            .with_owned_tag_deletes(self.delete_paths.clone());
        if let Some(owned) = &self.owned {
            wrapped = wrapped.with_owned_writes(owned.clone());
        }
        #[cfg(feature = "qualification")]
        {
            wrapped = wrapped.with_qualification_failure_prefix(self.failure_prefix.clone());
        }
        Arc::new(wrapped)
    }
    fn wrap_paginated(
        &self,
        _prefix: &str,
        _original: Arc<dyn object_store::list::PaginatedListStore>,
    ) -> Option<Arc<dyn object_store::list::PaginatedListStore>> {
        None
    }
}

fn sha(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn object_root(root: &FsPath) -> Result<Path> {
    Ok(Path::from_absolute_path(root)?)
}

fn scan_tree(root: &FsPath) -> Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut count = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            count += 1;
            ensure!(count <= 100_000, "Table metadata exceeds file-count bound");
            let metadata = fs::symlink_metadata(entry.path())?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "Symlink inside writable store"
            );
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                ensure!(metadata.is_file(), "Non-regular table entry");
            }
        }
    }
    Ok(())
}

fn verify_owner(request: &Request, root: &FsPath, require_no_readers: bool) -> Result<()> {
    let store = root.parent().context("Table parent missing")?;
    let lease = PathBuf::from(format!("{}.lease", store.display()));
    let expected = lease.join("exclusive-intent/owner.json");
    for directory in [
        &lease,
        &lease.join("exclusive-intent"),
        &lease.join("readers"),
    ] {
        ensure!(
            fs::symlink_metadata(directory)?.is_dir(),
            "Unverified lease directory"
        );
    }
    ensure!(
        !fs::symlink_metadata(&request.lease_owner)?
            .file_type()
            .is_symlink(),
        "Symlink lease owner"
    );
    ensure!(
        fs::canonicalize(&request.lease_owner)? == fs::canonicalize(expected)?,
        "Wrong store lease"
    );
    ensure!(
        fs::metadata(&request.lease_owner)?.len() <= 16 * 1024,
        "Oversized lease owner"
    );
    let bytes = fs::read(&request.lease_owner)?;
    let owner: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        owner["nonce"].as_str() == Some(&request.lease_nonce),
        "Exclusive nonce changed"
    );
    let helper = owner["activeHelper"]["pid"].as_u64();
    if let Some(helper) = helper {
        ensure!(
            helper == std::process::id() as u64,
            "Active helper PID changed"
        );
        ensure!(
            owner["activeHelper"]["processStart"].as_str()
                == Some(process_start(std::process::id())?.as_str()),
            "Active helper process identity changed"
        );
    } else {
        ensure!(
            owner["pid"].as_u64() == Some(unsafe { libc::getppid() } as u64),
            "Unverified helper parent"
        );
        ensure!(
            owner["processStart"].as_str()
                == Some(process_start(unsafe { libc::getppid() } as u32)?.as_str()),
            "Parent process identity changed"
        );
    }
    if require_no_readers {
        ensure!(
            lease.join("readers").is_dir(),
            "Reader lease directory missing"
        );
        ensure!(
            fs::read_dir(lease.join("readers"))?.all(|entry| entry
                .map(|entry| entry.path().extension() != Some(std::ffi::OsStr::new("json")))
                .unwrap_or(false)),
            "Shared owners must drain before mutation"
        );
    }
    Ok(())
}

fn process_start(pid: u32) -> Result<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()?;
    ensure!(output.status.success(), "Process identity unavailable");
    let start = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(!start.is_empty(), "Empty process identity");
    Ok(start)
}

fn check_space(request: &Request, root: &FsPath, charged: u64) -> Result<()> {
    let required = request
        .total_write_budget_bytes
        .checked_sub(charged)
        .and_then(|bytes| bytes.checked_add(request.free_space_margin_bytes))
        .context("Write reservation overflow")?;
    ensure!(
        free_bytes(root)? >= required,
        "Insufficient fresh free space for remaining writes plus margin"
    );
    Ok(())
}

pub fn emit(value: Value) -> Result<()> {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, &value)?;
    handle.write_all(b"\n")?;
    handle.flush()?;
    Ok(())
}
fn with_counts(mut value: Value, counts: Counts) -> Result<Value> {
    let object = value
        .as_object_mut()
        .context("Protocol counter object required")?;
    for (name, value) in serde_json::to_value(counts)?
        .as_object()
        .context("Counter fields required")?
    {
        object.insert(name.clone(), value.clone());
    }
    Ok(value)
}
fn remaining_space(
    request: &Request,
    root: &FsPath,
    receipt: &Receipt,
    counts: &Counts,
) -> Result<()> {
    let remaining = receipt
        .total_write_budget_bytes
        .checked_sub(counts.total_bytes_written)
        .context("Restored budget overrun")?;
    let needed = remaining
        .checked_add(request.free_space_margin_bytes)
        .context("Remaining reservation overflow")?;
    ensure!(
        free_bytes(root)? >= needed,
        "Insufficient fresh free space for remaining durable writes plus margin"
    );
    Ok(())
}
fn acknowledge(request: &Request) -> Result<()> {
    let mut line = String::new();
    std::io::stdin().lock().take(1024).read_line(&mut line)?;
    ensure!(
        line.trim_end() == request.lease_nonce,
        "Admission/drain acknowledgement absent"
    );
    Ok(())
}

async fn open(root: &FsPath, ledger: Arc<Ledger>, owned_tag_paths: Vec<Path>) -> Result<Dataset> {
    open_owned(root, ledger, owned_tag_paths, None, None).await
}
async fn open_owned(
    root: &FsPath,
    ledger: Arc<Ledger>,
    owned_tag_paths: Vec<Path>,
    owned: Option<Arc<OwnedWrites>>,
    _failure_prefix: Option<String>,
) -> Result<Dataset> {
    let url = url::Url::from_file_path(root).map_err(|_| anyhow!("Invalid local URI"))?;
    let uri = url.as_str().replacen("file:", "file-object-store:", 1);
    let url = url::Url::parse(&uri)?;
    let params = ObjectStoreParams {
        #[allow(deprecated)]
        object_store: Some((Arc::new(LocalFileSystem::new().with_fsync(true)), url)),
        object_store_wrapper: Some(Arc::new(Wrapper {
            ledger,
            root: object_root(root)?,
            delete_paths: owned_tag_paths,
            owned,
            #[cfg(feature = "qualification")]
            failure_prefix: _failure_prefix,
        })),
        list_is_lexically_ordered: Some(false),
        ..Default::default()
    };
    let dataset = DatasetBuilder::from_uri(&uri)
        .with_store_params(params)
        .with_commit_handler(Arc::new(crate::commit::LocalHeadCommit {
            root: root.to_owned(),
            object_root: object_root(root)?,
        }))
        .with_index_cache_size_bytes(8 * 1024 * 1024)
        .with_metadata_cache_size_bytes(8 * 1024 * 1024)
        .load()
        .await?;
    let store = dataset.object_store(None).await?;
    ensure!(
        store.scheme() == "file-object-store" && !store.has_direct_local_paths(),
        "Direct local writer bypass refused"
    );
    ensure!(
        dataset.manifest.base_paths.is_empty(),
        "External base stores refused"
    );
    ensure!(
        dataset.manifest.fragments.len() <= 4096,
        "Too many fragments for bounded metadata"
    );
    let schema = serde_json::to_value(ArrowSchema::from(dataset.schema()))?;
    ensure!(
        !schema.to_string().to_ascii_lowercase().contains("blob"),
        "Blob schema outside bounded writer"
    );
    for fragment in dataset.manifest.fragments.iter() {
        ensure!(
            fragment.overlays.is_empty(),
            "Overlay compaction not qualified"
        );
        for file in &fragment.files {
            ensure!(
                file.base_id.is_none()
                    && FsPath::new(&file.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        == Some(&file.path),
                "External/unverified data file"
            );
        }
        ensure!(
            fragment
                .deletion_file
                .as_ref()
                .is_none_or(|file| file.base_id.is_none()),
            "External deletion store refused"
        );
    }
    Ok(dataset)
}

async fn tags(dataset: &Dataset) -> Result<BTreeMap<String, u64>> {
    Ok(dataset
        .tags()
        .list()
        .await?
        .into_iter()
        .map(|(name, tag)| (name, tag.version))
        .collect())
}

async fn row_digest(dataset: &Dataset, fragments: Vec<Fragment>) -> Result<(usize, String)> {
    let schema = ArrowSchema::from(dataset.schema());
    let id_index = schema
        .index_of("id")
        .context("Stable application ID column required")?;
    let converter = RowConverter::new(
        schema
            .fields()
            .iter()
            .map(|field| SortField::new(field.data_type().clone()))
            .collect(),
    )?;
    let id_converter = RowConverter::new(vec![SortField::new(
        schema.field(id_index).data_type().clone(),
    )])?;
    let mut scanner = dataset.scan();
    scanner
        .with_fragments(fragments)
        .batch_size(64)
        .batch_size_bytes(1024 * 1024)
        .io_buffer_size(32 * 1024 * 1024);
    let mut stream = scanner.try_into_stream().await?;
    let mut rows = BTreeMap::<Vec<u8>, [u8; 32]>::new();
    let mut observed_bytes = 0usize;
    while let Some(batch) = stream.try_next().await? {
        let values = converter.convert_columns(batch.columns())?;
        let ids = id_converter.convert_columns(&[batch.column(id_index).clone()])?;
        for row in 0..batch.num_rows() {
            ensure!(!batch.column(id_index).is_null(row), "Null application ID");
            let id = ids.row(row).as_ref().to_vec();
            let encoded = values.row(row);
            observed_bytes = observed_bytes
                .checked_add(encoded.as_ref().len())
                .context("Verification byte overflow")?;
            ensure!(
                observed_bytes <= 64 * 1024 * 1024,
                "Selected-row verification exceeds 64 MiB decoded bound"
            );
            ensure!(
                rows.insert(id, Sha256::digest(encoded.as_ref()).into())
                    .is_none(),
                "Duplicate application ID in selected rows"
            );
            ensure!(
                rows.len() <= MAX_ROWS,
                "Selected-row verification exceeds row bound"
            );
        }
    }
    let mut digest = Sha256::new();
    for (id, value) in &rows {
        digest.update((id.len() as u64).to_le_bytes());
        digest.update(id);
        digest.update(value);
    }
    Ok((rows.len(), format!("{:x}", digest.finalize())))
}

async fn index_contract(dataset: &Dataset) -> Result<Vec<Value>> {
    let mut contract = vec![];
    for index in all_indices(dataset).await?.iter() {
        ensure!(index.base_id.is_none(), "External index store refused");
        contract.push(json!({"name":index.name,"fields":index.fields,"coveringFields":index.covering_fields,
            "type":index.index_details.as_ref().map(|details| details.type_url.clone()),"version":index.index_version}));
    }
    contract.sort_by_key(Value::to_string);
    Ok(contract)
}

async fn all_indices(dataset: &Dataset) -> Result<Vec<IndexMetadata>> {
    let store = dataset.object_store(None).await?;
    Ok(read_manifest_indexes(
        store.as_ref(),
        dataset.manifest_location(),
        dataset.manifest(),
    )
    .await?)
}

async fn fingerprint(dataset: &Dataset) -> Result<String> {
    let indices: Vec<_> = all_indices(dataset).await?.iter().map(|index| json!({
        "uuid":index.uuid.to_string(),"name":index.name,"fields":index.fields,"covering":index.covering_fields,
        "version":index.index_version,"datasetVersion":index.dataset_version,
        "coverage":index.fragment_bitmap.as_ref().map(|coverage| coverage.iter().collect::<Vec<_>>()),
        "details":index.index_details.as_ref().map(|details| (&details.type_url,&details.value))
    })).collect();
    Ok(sha(&serde_json::to_vec(
        &json!({"schema":ArrowSchema::from(dataset.schema()),
        "fragments":dataset.manifest.fragments,"indices":indices}),
    )?))
}

fn allocated_bytes(root: &FsPath) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    let mut pending = vec![root.to_owned()];
    let mut total = 0u64;
    let mut count = 0usize;
    while let Some(file) = pending.pop() {
        count += 1;
        ensure!(count <= 100_000, "Allocation metadata count bound");
        let metadata = fs::symlink_metadata(&file)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "Allocation scan refuses symlinks"
        );
        total = total
            .checked_add(
                metadata
                    .blocks()
                    .checked_mul(512)
                    .context("Allocation overflow")?,
            )
            .context("Allocation overflow")?;
        if metadata.is_dir() {
            for entry in fs::read_dir(file)? {
                pending.push(entry?.path());
            }
        } else {
            ensure!(
                metadata.is_file(),
                "Allocation scan refuses nonregular files"
            );
        }
    }
    Ok(total)
}

async fn index_source_bytes(
    dataset: &Dataset,
    root: &FsPath,
    selected: &BTreeSet<u64>,
) -> Result<u64> {
    if dataset.manifest.uses_stable_row_ids() {
        return Ok(0);
    }
    let mut total = 0u64;
    let all = all_indices(dataset).await?;
    ensure!(
        all.len() == dataset.load_indices().await?.len(),
        "Unreadable index declaration refused before copying"
    );
    for index in all.iter() {
        ensure!(index.base_id.is_none(), "External index store refused");
        let affected = index
            .fragment_bitmap
            .as_ref()
            .map(|coverage| coverage.iter().any(|id| selected.contains(&(id as u64))))
            .unwrap_or(true);
        if !affected {
            continue;
        }
        ensure!(
            index.covering_fields.is_empty() && index.fields.len() == 1,
            "Affected covering/composite index cannot be preserved"
        );
        let coverage = index
            .fragment_bitmap
            .as_ref()
            .context("Unknown affected index coverage refused before copying")?;
        ensure!(
            selected.iter().all(|id| coverage.contains(*id as u32)),
            "Selected fragments have mixed index coverage"
        );
        let field = dataset.schema().field_path(index.fields[0])?;
        let opened = dataset
            .open_generic_index(&field, &index.uuid, &NoOpMetricsCollector)
            .await?;
        match opened.index_type() {
            IndexType::BTree | IndexType::Inverted => {
                let scalar = dataset
                    .open_scalar_index(&field, &index.uuid, &NoOpMetricsCollector)
                    .await?;
                ensure!(scalar.can_remap(), "Affected scalar index cannot remap");
                if opened.index_type() == IndexType::Inverted {
                    let inverted = scalar
                        .as_any()
                        .downcast_ref::<InvertedIndex>()
                        .context("Unreadable FTS implementation")?;
                    ensure!(
                        !inverted.is_legacy(),
                        "Legacy FTS retraining would exceed selected-fragment scope"
                    );
                }
            }
            IndexType::IvfFlat => {}
            _ => bail!("Affected index type has no qualified remapping path"),
        }
        let directory = root.join("_indices").join(index.uuid.to_string());
        ensure!(directory.is_dir(), "Affected index directory missing");
        let mut pending = vec![directory];
        let mut files = 0usize;
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                files += 1;
                ensure!(files <= 100_000, "Index metadata file-count bound");
                let metadata = fs::symlink_metadata(entry.path())?;
                ensure!(!metadata.file_type().is_symlink(), "Symlink index entry");
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else {
                    ensure!(metadata.is_file(), "Nonregular index entry");
                    total = total
                        .checked_add(metadata.len())
                        .context("Index byte overflow")?;
                }
            }
        }
    }
    Ok(total)
}

async fn save_receipt(dataset: &Dataset, root: &FsPath, receipt: &Receipt) -> Result<()> {
    let bytes = serde_json::to_vec(receipt)?;
    ensure!(
        bytes.len() <= MAX_RECEIPT_BYTES,
        "Receipt metadata exceeded bounded bytes"
    );
    dataset
        .object_store(None)
        .await?
        .inner
        .put(&object_root(root)?.child(RECEIPT), bytes.into())
        .await?;
    Ok(())
}

fn read_receipt(root: &FsPath) -> Result<Option<Receipt>> {
    let file = root.join(RECEIPT);
    if !file.exists() {
        return Ok(None);
    }
    ensure!(
        fs::symlink_metadata(&file)?.is_file(),
        "Unverified receipt file"
    );
    ensure!(
        fs::metadata(&file)?.len() <= MAX_RECEIPT_BYTES as u64,
        "Oversized receipt"
    );
    let receipt: Receipt = serde_json::from_slice(&fs::read(file)?)?;
    ensure!(
        receipt.protocol_version == 2
            && receipt.total_write_budget_bytes > 0
            && receipt.total_write_budget_bytes <= MAX_SOURCE,
        "Unverified receipt protocol/budget"
    );
    ensure!(
        receipt
            .receipt_id
            .chars()
            .all(|letter| letter.is_ascii_alphanumeric() || letter == '-'),
        "Unverified receipt identity"
    );
    ensure!(
        receipt.journal == format!("_gmax-maintenance-{}.journal", receipt.receipt_id),
        "Unverified journal identity"
    );
    ensure!(
        receipt.owned_writes == format!("_gmax-owned-{}.jsonl", receipt.receipt_id),
        "Unverified ownership identity"
    );
    ensure!(
        receipt.retired_metadata.len() <= 128
            && receipt.retired_metadata.iter().all(|name| {
                let id = name
                    .strip_prefix("_gmax-maintenance-")
                    .and_then(|name| name.strip_suffix(".journal"))
                    .or_else(|| {
                        name.strip_prefix("_gmax-owned-")
                            .and_then(|name| name.strip_suffix(".jsonl"))
                    });
                id.is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            }),
        "Unverified retired metadata identity"
    );
    ensure!(
        receipt.reader_tag == format!("gmax-native-{}-before", receipt.receipt_id)
            && receipt.after_tag == format!("gmax-native-{}-after", receipt.receipt_id),
        "Unverified protective tag identity"
    );
    Ok(Some(receipt))
}

fn orphan_metadata(root: &FsPath, receipt: Option<&Receipt>) -> Result<Vec<String>> {
    let mut referenced = BTreeSet::new();
    if let Some(receipt) = receipt {
        referenced.insert(receipt.journal.clone());
        referenced.insert(receipt.owned_writes.clone());
        referenced.extend(receipt.retired_metadata.iter().cloned());
    }
    let mut journals = BTreeMap::new();
    let mut logs = BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if referenced.contains(name) {
            continue;
        }
        let journal = name
            .strip_prefix("_gmax-maintenance-")
            .and_then(|name| name.strip_suffix(".journal"));
        let log = name
            .strip_prefix("_gmax-owned-")
            .and_then(|name| name.strip_suffix(".jsonl"));
        let Some(id) = journal.or(log) else {
            continue;
        };
        ensure!(
            id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
            "Unknown custom metadata file"
        );
        ensure!(
            fs::symlink_metadata(entry.path())?.is_file(),
            "Unsafe orphan metadata"
        );
        if journal.is_some() {
            journals.insert(id.to_owned(), name.to_owned());
        } else {
            logs.insert(id.to_owned(), name.to_owned());
        }
        ensure!(
            journals.len() + logs.len() <= 126,
            "Orphan custom metadata count bound exceeded"
        );
    }
    let mut retired = vec![];
    for (id, name) in &journals {
        let mut first = [0u8; 8];
        fs::File::open(root.join(name))?.read_exact(&mut first)?;
        let cap = u64::from_le_bytes(first);
        // Restoration checks every checksum and keeps an advisory lock. A
        // still-running creator cannot be mistaken for abandoned metadata.
        let journal = Ledger::restore(cap, &root.join(name))?;
        let counts = journal.counts();
        ensure!(
            counts.data_bytes_written == 0
                && counts.index_bytes_written == 0
                && counts.verification_bytes_written == 0,
            "Unreferenced payload attempt requires operator review"
        );
        let before = format!("gmax-native-{id}-before.json");
        let after = format!("gmax-native-{id}-after.json");
        ensure!(
            !root.join("_refs/tags").join(before).exists()
                && !root.join("_refs/tags").join(after).exists(),
            "Unreferenced protected attempt requires operator review"
        );
        if let Some(log) = logs.remove(id) {
            ensure!(
                fs::metadata(root.join(&log))?.len() == 0,
                "Unreferenced nonempty ownership log requires operator review"
            );
            retired.push(log);
        }
        retired.push(name.clone());
    }
    ensure!(
        logs.is_empty(),
        "Unreferenced ownership log has no verifiable journal"
    );
    Ok(retired)
}

async fn verify_candidate(before: &Dataset, after: &Dataset, receipt: &Receipt) -> Result<usize> {
    ensure!(
        ArrowSchema::from(before.schema()) == ArrowSchema::from(after.schema()),
        "Schema changed"
    );
    let old: BTreeMap<_, _> = before
        .manifest
        .fragments
        .iter()
        .map(|fragment| (fragment.id, fragment.clone()))
        .collect();
    let new: BTreeMap<_, _> = after
        .manifest
        .fragments
        .iter()
        .map(|fragment| (fragment.id, fragment.clone()))
        .collect();
    let selected: BTreeSet<_> = receipt.selected_fragment_ids.iter().copied().collect();
    let removed: BTreeSet<_> = old
        .keys()
        .filter(|id| !new.contains_key(id))
        .copied()
        .collect();
    ensure!(
        selected == removed,
        "Native rewrite changed an unplanned fragment"
    );
    for (id, fragment) in &old {
        if let Some(surviving) = new.get(id) {
            ensure!(fragment == surviving, "Unselected fragment changed");
        }
    }
    let originals: Vec<_> = old
        .values()
        .filter(|fragment| selected.contains(&fragment.id))
        .cloned()
        .collect();
    let replacements: Vec<_> = new
        .values()
        .filter(|fragment| !old.contains_key(&fragment.id))
        .cloned()
        .collect();
    let source = row_digest(before, originals).await?;
    let candidate = row_digest(after, replacements).await?;
    ensure!(
        source == candidate
            && source.1 == receipt.source_rows_digest
            && source.0 == receipt.rows_verified,
        "Stable-ID/all-fields comparison failed"
    );
    ensure!(
        before.count_rows(None).await? == after.count_rows(None).await?,
        "Live row count changed"
    );
    ensure!(
        index_contract(before).await? == index_contract(after).await?,
        "Search index contract changed"
    );
    // Enforce exact affected/unaffected index coverage, not just names.
    let old_indices = before.load_indices().await?;
    let new_indices = after.load_indices().await?;
    let replacement_ids: BTreeSet<u32> = new
        .keys()
        .filter(|id| !old.contains_key(id))
        .map(|id| *id as u32)
        .collect();
    for old_index in old_indices.iter() {
        let candidates: Vec<_> = new_indices
            .iter()
            .filter(|index| index.name == old_index.name && index.fields == old_index.fields)
            .collect();
        if let Some(coverage) = &old_index.fragment_bitmap {
            let mut expected: BTreeSet<u32> = coverage.iter().collect();
            if selected.iter().any(|id| expected.contains(&(*id as u32))) {
                for id in &selected {
                    expected.remove(&(*id as u32));
                }
                expected.extend(&replacement_ids);
            }
            ensure!(
                candidates.iter().any(|index| index
                    .fragment_bitmap
                    .as_ref()
                    .map(|coverage| coverage.iter().collect::<BTreeSet<_>>() == expected)
                    .unwrap_or(false)),
                "Search index fragment coverage changed"
            );
        } else {
            bail!("Unknown search-index coverage is outside independent equivalence proof");
        }
    }
    Ok(source.0)
}

pub async fn run(request: Request) -> Result<()> {
    ensure!(
        request.protocol_version == 2 && (request.action == "run" || request.action == "recover"),
        "Unsupported request protocol/action"
    );
    ensure!(
        request.expected_version > 0
            && request.source_limit_bytes > 0
            && request.source_limit_bytes <= MAX_SOURCE,
        "Invalid version/source bound"
    );
    ensure!(
        request.free_space_margin_bytes > 0 && request.free_space_margin_bytes <= (1u64 << 53) - 1,
        "Invalid free-space margin"
    );
    Ledger::new(request.total_write_budget_bytes)?;
    ensure!(
        !request.lease_nonce.is_empty()
            && request.lease_nonce.len() <= 128
            && request
                .lease_nonce
                .chars()
                .all(|letter| letter.is_ascii_alphanumeric() || letter == '-'),
        "Invalid lease nonce"
    );
    ensure!(
        !fs::symlink_metadata(&request.store)?
            .file_type()
            .is_symlink(),
        "Symlink table root"
    );
    let root = fs::canonicalize(&request.store)?;
    ensure!(
        root.is_dir() && root.extension() == Some(std::ffi::OsStr::new("lance")),
        "Local Lance directory required"
    );
    scan_tree(&root)?;
    verify_owner(&request, &root, true)?;
    let allocated_before = allocated_bytes(&root)?;
    let free_before = free_bytes(&root)?;
    emit(json!({"phase":"launch"}))?;
    acknowledge(&request)?;
    verify_owner(&request, &root, true)?;
    let previous = read_receipt(&root)?;
    let mut restored_ledger = if request.action == "recover" {
        if let Some(receipt) = previous
            .as_ref()
            .filter(|receipt| receipt.phase != "finalized")
        {
            ensure!(
                receipt.total_write_budget_bytes <= request.total_write_budget_bytes,
                "Recovery allowance exceeds configured cap"
            );
            let ledger = Ledger::restore(
                receipt.total_write_budget_bytes,
                &root.join(&receipt.journal),
            )?;
            remaining_space(&request, &root, receipt, &ledger.counts())?;
            Some(ledger)
        } else {
            check_space(&request, &root, 0)?;
            None
        }
    } else {
        check_space(&request, &root, 0)?;
        None
    };
    let orphan_retirement = orphan_metadata(&root, previous.as_ref())?;
    let mut receipt;
    let mut recovering_finalization = false;
    let mut aborting = false;
    let mut recovered_candidate = false;
    let preliminary = Arc::new(Ledger::new(request.total_write_budget_bytes)?);
    let mut dataset = open(&root, preliminary, vec![]).await?;
    let observed_latest = dataset.latest_version_id().await?;
    ensure!(
        dataset.version_id() == request.expected_version
            && observed_latest == request.expected_version,
        "Table changed before planning: requested {}, opened {}, latest {}",
        request.expected_version,
        dataset.version_id(),
        observed_latest
    );
    let mut plan_tasks = vec![];
    let mut options = CompactionOptions {
        target_rows_per_fragment: 8192,
        max_rows_per_group: 64,
        max_bytes_per_file: Some(256 * 1024 * 1024),
        materialize_deletions: true,
        materialize_deletions_threshold: 0.0,
        num_threads: Some(1),
        batch_size: Some(64),
        io_buffer_size: Some(32 * 1024 * 1024),
        defer_index_remap: false,
        compaction_mode: Some(CompactionMode::Reencode),
        max_source_fragments: Some(MAX_FRAGMENTS),
        max_source_rows: Some(MAX_ROWS),
        max_source_bytes: Some(request.source_limit_bytes.min(32 * 1024 * 1024)),
        ..Default::default()
    };
    if request.action == "run" {
        if let Some(previous) = &previous {
            if previous.phase != "finalized" {
                emit(
                    json!({"phase":"error","status":"recover-required","code":"recover-required",
                    "receiptId":previous.receipt_id,"totalWriteBudgetBytes":previous.total_write_budget_bytes,
                    "beforeVersion":previous.before_version,"currentVersion":request.expected_version,
                    "reason":"Interrupted receipt exists; explicit recovery required before any new copy"}),
                )?;
                return Err(anyhow!(ReportedError(
                    "Interrupted receipt requires explicit recovery".into()
                )));
            }
        }
        for fragment in dataset.get_fragments() {
            let excluded = fragment.count_deletions().await? == 0
                || request
                    .selected_fragment_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&(fragment.id() as u64)));
            if excluded {
                options.excluded_fragment_ids.push(fragment.id() as u32);
            }
        }
        let plan = plan_compaction(&dataset, &options).await?;
        // One task keeps index coverage uniform and avoids including every
        // newly written replacement in indexes covering only a different task.
        let smallest = plan
            .tasks
            .iter()
            .enumerate()
            .map(|(number, task)| {
                let bytes = task
                    .fragments
                    .iter()
                    .flat_map(|fragment| fragment.files.iter())
                    .try_fold(0u64, |sum, file| {
                        sum.checked_add(fs::metadata(root.join("data").join(&file.path))?.len())
                            .context("Source byte overflow")
                    })?;
                Ok::<_, anyhow::Error>((bytes, number))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .min();
        let chosen = smallest.map(|(_, number)| number);
        plan_tasks = plan
            .compaction_tasks()
            .enumerate()
            .filter_map(|(number, task)| (Some(number) == chosen).then_some(task))
            .collect();
        let selected: Vec<Fragment> = plan
            .tasks
            .iter()
            .enumerate()
            .filter_map(|(number, task)| (Some(number) == chosen).then_some(task))
            .flat_map(|task| task.fragments.iter().cloned())
            .collect();
        if selected.is_empty() {
            let no_work_plan = json!({"protocolVersion":2,"engine":"12.0.0","status":"no-work","action":request.action,
                "expectedVersion":request.expected_version,"beforeVersion":request.expected_version,"protectedVersion":request.expected_version,"planId":sha(b"no-work"),
                "totalWriteBudgetBytes":request.total_write_budget_bytes,"sharedTotalWriteCapBytes":request.total_write_budget_bytes,
                "freeSpaceMarginBytes":request.free_space_margin_bytes,"nativeTotalWriteBudgetEnforced":true,
                "budgetKind":"cumulative-writes","effectiveStoreScheme":"file-object-store"});
            emit(with_counts(
                json!({"phase":"ready","plan":no_work_plan}),
                Counts::default(),
            )?)?;
            acknowledge(&request)?;
            let remaining = dataset.count_deleted_rows().await?;
            emit(
                json!({"phase":"result","status":"no-work","beforeVersion":request.expected_version,"afterVersion":request.expected_version,
                "planId":sha(b"no-work"),"receiptId":"","totalBytesWritten":0,"dataBytesWritten":0,"indexBytesWritten":0,"metadataBytesWritten":0,"verificationBytesWritten":0,"rowsVerified":0,
                "recoveryPending":false,"remainingDeletedRows":remaining,"freeBytesBefore":free_before,"freeBytesAfter":free_bytes(&root)?,"allocatedBytesBefore":allocated_before,"allocatedBytesAfter":allocated_bytes(&root)?}),
            )?;
            return Ok(());
        }
        ensure!(
            selected.len() <= MAX_FRAGMENTS,
            "Selected fragment bound exceeded"
        );
        let ids: Vec<u64> = selected.iter().map(|fragment| fragment.id).collect();
        ensure!(
            ids.iter().copied().collect::<BTreeSet<_>>().len() == ids.len(),
            "Duplicate planned source fragment"
        );
        if let Some(requested) = &request.selected_fragment_ids {
            ensure!(
                requested.iter().copied().collect::<BTreeSet<_>>() == ids.iter().copied().collect(),
                "Requested source plan changed"
            );
        }
        let mut source_bytes = 0u64;
        for fragment in &selected {
            for file in &fragment.files {
                source_bytes = source_bytes
                    .checked_add(fs::metadata(root.join("data").join(&file.path))?.len())
                    .context("Source byte overflow")?;
            }
        }
        ensure!(
            source_bytes <= request.source_limit_bytes,
            "Actual source bytes exceed source cap"
        );
        let index_bytes =
            index_source_bytes(&dataset, &root, &ids.iter().copied().collect()).await?;
        ensure!(
            source_bytes
                .checked_add(index_bytes)
                .and_then(|bytes| bytes.checked_add(64 * 1024))
                .is_some_and(|bytes| bytes <= request.total_write_budget_bytes),
            "Current affected index/source footprint exceeds total write budget before copying"
        );
        // Decode selected rows after durable protection/read readiness, so
        // bounded verification does not prolong the initial reader pause.
        let rows = 0;
        let digest = String::new();
        let original_tags = tags(&dataset).await?;
        ensure!(original_tags.len() <= 254, "Tag metadata bound exceeded");
        let receipt_id = sha(format!(
            "{}:{}:{}:{:?}",
            request.lease_nonce,
            request.expected_version,
            std::process::id(),
            std::time::SystemTime::now()
        )
        .as_bytes());
        let plan_id = sha(&serde_json::to_vec(
            &json!({"version":request.expected_version,"selected":ids,"sourceBytes":source_bytes,
            "rowsDigest":digest,"totalWriteBudgetBytes":request.total_write_budget_bytes,"schema":ArrowSchema::from(dataset.schema()),
            "fragments":dataset.manifest.fragments,"indices":index_contract(&dataset).await?}),
        )?);
        receipt = Receipt {
            protocol_version: 2,
            phase: "protecting".into(),
            receipt_id: receipt_id.clone(),
            plan_id,
            before_version: request.expected_version,
            after_version: None,
            verified_copy_version: None,
            selected_fragment_ids: ids,
            reader_tag: format!("gmax-native-{receipt_id}-before"),
            after_tag: format!("gmax-native-{receipt_id}-after"),
            original_tags,
            journal: format!("_gmax-maintenance-{receipt_id}.journal"),
            owned_writes: format!("_gmax-owned-{receipt_id}.jsonl"),
            total_write_budget_bytes: request.total_write_budget_bytes,
            source_bytes,
            source_rows_digest: digest,
            rows_verified: rows,
            before_fingerprint: fingerprint(&dataset).await?,
            accepted_fingerprint: None,
            helper_pid: std::process::id(),
            helper_start: process_start(std::process::id())?,
            aborted: false,
            abort_proven: false,
            finalization_reserve_bytes: (512 * 1024).min(request.total_write_budget_bytes / 2),
            retired_metadata: previous
                .as_ref()
                .map(|old| vec![old.journal.clone(), old.owned_writes.clone()])
                .unwrap_or_default()
                .into_iter()
                .chain(orphan_retirement)
                .collect(),
        };
    } else {
        if previous
            .as_ref()
            .is_none_or(|receipt| receipt.phase == "finalized")
        {
            let plan_id = sha(b"no-recovery");
            emit(with_counts(
                json!({"phase":"ready","plan":{"protocolVersion":2,"engine":"12.0.0","status":"no-work","action":"recover",
                "expectedVersion":request.expected_version,"beforeVersion":request.expected_version,"protectedVersion":request.expected_version,
                "planId":plan_id,"sharedTotalWriteCapBytes":request.total_write_budget_bytes,"totalWriteBudgetBytes":request.total_write_budget_bytes,
                "freeSpaceMarginBytes":request.free_space_margin_bytes,"budgetKind":"cumulative-writes","nativeTotalWriteBudgetEnforced":true,"effectiveStoreScheme":"file-object-store"}}),
                Counts::default(),
            )?)?;
            acknowledge(&request)?;
            emit(
                json!({"phase":"result","status":"no-work","beforeVersion":request.expected_version,"afterVersion":request.expected_version,
                "planId":plan_id,"receiptId":"","totalBytesWritten":0,"dataBytesWritten":0,"indexBytesWritten":0,"metadataBytesWritten":0,"verificationBytesWritten":0,
                "rowsVerified":0,"recoveryPending":false,"remainingDeletedRows":dataset.count_deleted_rows().await?}),
            )?;
            return Ok(());
        }
        receipt = previous.clone().context("No owned recovery receipt")?;
        ensure!(
            receipt.phase != "finalized",
            "Recovery already finalized; no duplicate operation"
        );
        ensure!(
            receipt.total_write_budget_bytes <= request.total_write_budget_bytes,
            "Recovery cannot reset/change write budget"
        );
        let prior_alive = process_start(receipt.helper_pid)
            .ok()
            .is_some_and(|start| start == receipt.helper_start);
        ensure!(
            !prior_alive,
            "Prior native helper is still alive; cannot recover its attempt"
        );
        let protected = tags(&dataset).await?;
        recovering_finalization = receipt.phase == "finalizing" || receipt.phase == "aborted";
        if recovering_finalization {
            ensure!(
                receipt
                    .after_version
                    .is_some_and(|version| version <= request.expected_version)
                    && receipt
                        .accepted_fingerprint
                        .as_ref()
                        .is_some_and(|digest| digest.len() == 64),
                "Durably accepted proof invalid; cannot release protection blindly"
            );
            // Finalizing was persisted only after exact verification and a
            // reader drain. Ordinary subsequent edits may advance the head;
            // finalize the already accepted attempt without copying again.
            receipt.verified_copy_version = receipt.verified_copy_version.or(receipt.after_version);
            if receipt.after_version == Some(request.expected_version) {
                ensure!(
                    receipt.accepted_fingerprint.as_deref()
                        == Some(fingerprint(&dataset).await?.as_str()),
                    "Accepted head identity changed"
                );
            }
            receipt.after_version = Some(request.expected_version);
        } else if receipt.after_version.is_none() {
            if fingerprint(&dataset).await? == receipt.before_fingerprint {
                // The original logical head is unchanged, including all index
                // identities and fragments. Abandoned uncommitted files are
                // left for independent retention; never copy again or refund.
                aborting = true;
                receipt.aborted = true;
                receipt.after_version = Some(request.expected_version);
                receipt.verified_copy_version = Some(request.expected_version);
            } else {
                ensure!(
                    protected.get(&receipt.reader_tag) == Some(&receipt.before_version),
                    "Original recovery head unprotected"
                );
                let before = dataset.checkout_version(receipt.before_version).await?;
                verify_candidate(&before, &dataset, &receipt)
                    .await
                    .context("Uncertain copy/head changed; no retry or blind tag release")?;
                receipt.after_version = Some(request.expected_version);
            }
        } else {
            ensure!(
                receipt
                    .after_version
                    .is_some_and(|version| version <= request.expected_version),
                "Candidate version invalid"
            );
            ensure!(
                protected.get(&receipt.reader_tag) == Some(&receipt.before_version)
                    && protected.get(&receipt.after_tag) == receipt.after_version.as_ref(),
                "Recovery protected heads changed"
            );
            let copy_version = receipt
                .after_version
                .context("Copied candidate version missing")?;
            let candidate = dataset.checkout_version(copy_version).await?;
            let before = dataset.checkout_version(receipt.before_version).await?;
            receipt.rows_verified = verify_candidate(&before, &candidate, &receipt).await?;
            receipt.verified_copy_version = Some(copy_version);
            receipt.after_version = Some(request.expected_version);
            recovered_candidate = true;
        }
    }
    let protection_version = if request.action == "recover" {
        request.expected_version
    } else {
        receipt.before_version
    };
    let protection_tag = if request.action == "recover" {
        receipt.after_tag.clone()
    } else {
        receipt.reader_tag.clone()
    };
    let proof = with_counts(
        json!({"protocolVersion":2,"engine":"12.0.0","status":"qualified","action":request.action,
        "expectedVersion":request.expected_version,"beforeVersion":receipt.before_version,"protectedVersion":protection_version,"planId":receipt.plan_id,
        "totalWriteBudgetBytes":receipt.total_write_budget_bytes,"sharedTotalWriteCapBytes":receipt.total_write_budget_bytes,
        "freeSpaceMarginBytes":request.free_space_margin_bytes,"nativeTotalWriteBudgetEnforced":true,
        "budgetKind":"cumulative-writes","effectiveStoreScheme":"file-object-store"}),
        restored_ledger
            .as_ref()
            .map(Ledger::counts)
            .unwrap_or_default(),
    )?;
    emit(with_counts(
        json!({"phase":"ready","plan":proof}),
        restored_ledger
            .as_ref()
            .map(Ledger::counts)
            .unwrap_or_default(),
    )?)?;
    acknowledge(&request)?;
    verify_owner(&request, &root, true)?;
    if let Some(ledger) = &restored_ledger {
        remaining_space(&request, &root, &receipt, &ledger.counts())?;
    } else {
        check_space(&request, &root, 0)?;
    }
    scan_tree(&root)?;
    ensure!(
        serde_json::to_vec(&receipt)?.len() <= MAX_RECEIPT_BYTES,
        "Receipt size exceeds preflight bound"
    );
    let tag_paths = vec![
        object_root(&root)?
            .child("_refs")
            .child("tags")
            .child(format!("{}.json", receipt.reader_tag)),
        object_root(&root)?
            .child("_refs")
            .child("tags")
            .child(format!("{}.json", receipt.after_tag)),
    ];
    let mut finalization_paths = tag_paths.clone();
    finalization_paths.push(object_root(&root)?.child(RECEIPT));
    let ledger = Arc::new(
        if request.action == "run" {
            Ledger::with_guarded_journal(
                receipt.total_write_budget_bytes,
                &root.join(&receipt.journal),
                root.clone(),
                request.free_space_margin_bytes,
            )?
        } else {
            restored_ledger
                .take()
                .context("Restored attempt journal required")?
        }
        .with_space_guard(root.clone(), request.free_space_margin_bytes)
        .with_finalization_reserve(receipt.finalization_reserve_bytes)
        .with_finalization_paths(finalization_paths),
    );
    // Persist initial receipt before creating any payload ownership state. A
    // crash in this admission window is recoverable without copying.
    if request.action == "run" {
        dataset = open(&root, ledger.clone(), tag_paths.clone()).await?;
        save_receipt(&dataset, &root, &receipt).await?;
    }
    let owned_result = if request.action == "run"
        || (!root.join(&receipt.owned_writes).exists()
            && ledger.counts().data_bytes_written == 0
            && ledger.counts().index_bytes_written == 0)
    {
        OwnedWrites::create(ledger.clone(), root.clone(), &receipt.owned_writes)
    } else {
        OwnedWrites::restore(ledger.clone(), root.clone(), &receipt.owned_writes)
    };
    let ownership_error = owned_result.as_ref().err().map(ToString::to_string);
    let owned = owned_result.ok().map(Arc::new);
    if request.action == "run" {
        ensure!(
            owned.is_some(),
            "Ownership persistence failed: {ownership_error:?}"
        );
    }
    let failure_prefix = {
        #[cfg(feature = "qualification")]
        {
            request.qualification_fail_path_prefix.clone()
        }
        #[cfg(not(feature = "qualification"))]
        {
            None
        }
    };
    dataset = open_owned(
        &root,
        ledger.clone(),
        tag_paths,
        owned.clone(),
        failure_prefix,
    )
    .await?;
    let operation = async {
        ensure!(dataset.version_id() == request.expected_version && dataset.latest_version_id().await? == request.expected_version, "Head changed at write admission");
        if request.action == "run" {
            save_receipt(&dataset, &root, &receipt).await?;
            if !receipt.retired_metadata.is_empty() {
                // Retire only the last finalized attempt's custom metadata.
                // Its fixed receipt has now been atomically superseded.
                for basename in &receipt.retired_metadata {
                    let path = root.join(basename);
                    match fs::symlink_metadata(&path) {
                        Ok(meta) if meta.is_file() => {
                            ledger.charge(&Path::from("_gmax-maintenance/journal"), 0)?;
                            fs::remove_file(path)?; fs::File::open(&root)?.sync_all()?;
                        },
                        Ok(_) => bail!("Retired attempt metadata is unsafe"),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                        Err(error) => return Err(error.into()),
                    }
                }
                receipt.retired_metadata.clear(); save_receipt(&dataset, &root, &receipt).await?;
            }
            dataset.tags().create(&receipt.reader_tag, receipt.before_version).await?;
            receipt.phase = "protected".into(); save_receipt(&dataset, &root, &receipt).await?;
        } else if recovering_finalization || recovered_candidate {
            ledger.enter_metadata_finalization()?;
            receipt.helper_pid = std::process::id(); receipt.helper_start = process_start(std::process::id())?;
            receipt.accepted_fingerprint = Some(fingerprint(&dataset).await?);
            receipt.phase = "finalizing".into(); save_receipt(&dataset, &root, &receipt).await?;
            if let Some(version) = tags(&dataset).await?.get(&protection_tag) {
                if *version != protection_version {
                    ensure!(Some(*version) == receipt.verified_copy_version, "Recovery tag is not owned accepted copy");
                    dataset.tags().delete(&protection_tag).await?;
                }
            }
            if tags(&dataset).await?.get(&protection_tag) != Some(&protection_version) {
                dataset.tags().create(&protection_tag, protection_version).await?;
            }
        } else if aborting {
            // Recover a proven uncommitted attempt without rewriting rows.
            ledger.enter_metadata_finalization()?;
            if !tags(&dataset).await?.contains_key(&protection_tag) {
                dataset.tags().create(&protection_tag, protection_version).await?;
            }
        } else if !tags(&dataset).await?.contains_key(&receipt.after_tag) {
            // Commit succeeded before its after-tag/receipt update. The read-only
            // preflight proved this exact candidate, so protect it without copying.
            dataset.tags().create(&receipt.after_tag, request.expected_version).await?;
            receipt.phase = "copied".into(); save_receipt(&dataset, &root, &receipt).await?;
        }
        emit(with_counts(json!({"phase":"protected-read-ready","beforeVersion":receipt.before_version,"protectedVersion":protection_version,"planId":receipt.plan_id,"readerTag":protection_tag,"receiptId":receipt.receipt_id}), ledger.counts())?)?;
        acknowledge(&request)?; verify_owner(&request, &root, false)?;
        if request.action == "run" {
            let selected: Vec<_> = dataset.manifest.fragments.iter().filter(|fragment| receipt.selected_fragment_ids.contains(&fragment.id)).cloned().collect();
            let (rows, digest) = row_digest(&dataset, selected).await?;
            receipt.rows_verified = rows; receipt.source_rows_digest = digest;
            receipt.phase = "copying".into(); save_receipt(&dataset, &root, &receipt).await?;
            let mut copies = vec![];
            for task in &plan_tasks { copies.push(task.execute(&dataset).await?); }
            let uncommitted: Vec<_> = copies.iter().flat_map(|copy| copy.new_fragments.iter().cloned()).collect();
            let (rows, digest) = row_digest(&dataset, uncommitted).await?;
            ensure!(rows == receipt.rows_verified && digest == receipt.source_rows_digest,
                "Uncommitted row copy differs; original head remains protected");
            verify_owner(&request, &root, false)?;
            ensure!(dataset.latest_version_id().await? == receipt.before_version, "Head changed before compaction commit");
            commit_compaction(&mut dataset, copies, Arc::new(DatasetIndexRemapperOptions::default()), &options).await?;
            receipt.after_version = Some(dataset.version_id());
            receipt.verified_copy_version = receipt.after_version;
            dataset.tags().create(&receipt.after_tag, dataset.version_id()).await?;
            receipt.phase = "copied".into(); save_receipt(&dataset, &root, &receipt).await?;
        }
        if aborting {
            ensure!(fingerprint(&dataset).await? == receipt.before_fingerprint, "Uncommitted logical head changed before abort");
            receipt.rows_verified = 0;
        } else if !recovering_finalization && !recovered_candidate {
            let before = dataset.checkout_version(receipt.before_version).await?;
            receipt.rows_verified = verify_candidate(&before, &dataset, &receipt).await?;
            receipt.phase = "verified".into(); save_receipt(&dataset, &root, &receipt).await?;
        }
        emit(with_counts(json!({"phase":"reader-drain","beforeVersion":receipt.before_version,"protectedVersion":protection_version,"afterVersion":receipt.after_version,"planId":receipt.plan_id,
            "readerTag":protection_tag,"receiptId":receipt.receipt_id}), ledger.counts())?)?;
        acknowledge(&request)?; verify_owner(&request, &root, true)?;
        ensure!(dataset.latest_version_id().await? == receipt.after_version.context("Candidate version missing")?, "Head changed before finalization");
        ledger.enter_metadata_finalization()?;
        let protected = tags(&dataset).await?;
        let mut external = protected.clone();
        if let Some(version) = external.remove(&receipt.reader_tag) { ensure!(version == receipt.before_version, "Owned before tag changed"); }
        if let Some(version) = external.remove(&receipt.after_tag) { ensure!(Some(version) == receipt.after_version, "Owned after tag changed"); }
        ensure!(external == receipt.original_tags, "External protected tags changed");
        // Durable accepted proof precedes the first deletion. A crash after
        // either deletion can resume from the current accepted head without
        // requiring a snapshot whose protection was already released.
        if aborting {
            ensure!(fingerprint(&dataset).await? == receipt.before_fingerprint, "Logical abort proof changed after drain");
            receipt.abort_proven = true;
        }
        receipt.accepted_fingerprint = Some(fingerprint(&dataset).await?);
        receipt.phase = "finalizing".into(); save_receipt(&dataset, &root, &receipt).await?;
        let mut cleanup_pending = ownership_error.is_some();
        let mut cleanup_failure = ownership_error.clone();
        if receipt.aborted {
            ensure!(receipt.abort_proven, "Durable logical abort proof invalid before owned reclamation");
            if let Some(owned) = &owned {
                let mut references: Vec<_> = dataset.manifest.fragments.iter().flat_map(|fragment| fragment.files.iter())
                    .map(|file| object_root(&root).map(|root| root.child("data").child(&file.path))).collect::<Result<_>>()?;
                references.extend(all_indices(&dataset).await?.iter().map(|index| object_root(&root).map(|root| root.child("_indices").child(index.uuid.to_string()))).collect::<Result<Vec<_>>>()?);
                if owned.referenced_by(&references)? { cleanup_pending = true; cleanup_failure = Some("Owned target now referenced by current head".into()); }
                else if let Err(error) = owned.cleanup_proven_abort() { cleanup_pending = true; cleanup_failure = Some(error.to_string()); }
            } else { cleanup_pending = true; }
        }
        if protected.contains_key(&receipt.reader_tag) { dataset.tags().delete(&receipt.reader_tag).await?; }
        #[cfg(feature = "qualification")]
        if request.qualification_pause_after_first_tag_delete {
            emit(json!({"phase":"qualification-after-first-tag-delete","receiptId":receipt.receipt_id}))?;
            acknowledge(&request)?;
        }
        if protected.contains_key(&receipt.after_tag) { dataset.tags().delete(&receipt.after_tag).await?; }
        ensure!(tags(&dataset).await? == receipt.original_tags, "External tags changed during finalization");
        for basename in &receipt.retired_metadata {
            let path = root.join(basename);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_file() => {
                    ledger.charge(&Path::from("_gmax-maintenance/journal"), 0)?;
                    fs::remove_file(path)?; fs::File::open(&root)?.sync_all()?;
                },
                Ok(_) => bail!("Retired metadata is unsafe"),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
        }
        receipt.retired_metadata.clear();
        receipt.phase = if cleanup_pending { "aborted" } else { "finalized" }.into();
        save_receipt(&dataset, &root, &receipt).await?;
        let mut result = serde_json::to_value(ledger.counts())?;
        result["phase"] = json!("result"); result["status"] = json!(if request.action == "run" {"committed"} else {"recovered"});
        result["beforeVersion"] = json!(receipt.before_version); result["protectedVersion"] = json!(protection_version); result["afterVersion"] = json!(receipt.after_version);
        result["planId"] = json!(receipt.plan_id); result["receiptId"] = json!(receipt.receipt_id);
        result["rowsVerified"] = json!(receipt.rows_verified); result["aborted"] = json!(receipt.aborted);
        result["acceptedFinalization"] = json!(recovering_finalization || recovered_candidate);
        result["verifiedCopyVersion"] = json!(receipt.verified_copy_version);
        result["recoveryPending"] = json!(cleanup_pending);
        if let Some(reason) = &cleanup_failure { result["recoveryBlockReason"] = json!(reason); }
        result["remainingDeletedRows"] = json!(dataset.count_deleted_rows().await?);
        result["freeBytesBefore"] = json!(free_before); result["freeBytesAfter"] = json!(free_bytes(&root)?);
        result["allocatedBytesBefore"] = json!(allocated_before); result["allocatedBytesAfter"] = json!(allocated_bytes(&root)?);
        emit(result)?;
        Ok::<_, anyhow::Error>(())
    }.await;
    if let Err(error) = operation {
        let mut outcome = serde_json::to_value(ledger.counts())?;
        outcome["phase"] = json!("error");
        outcome["status"] = json!("uncertain");
        outcome["reason"] = json!(error.to_string());
        outcome["receiptId"] = json!(receipt.receipt_id);
        emit(outcome)?;
        return Err(anyhow!(ReportedError(error.to_string())));
    }
    Ok(())
}

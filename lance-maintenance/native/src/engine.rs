//! Pinned Lance execution through a metered, durable local object store.
//! Source and lifecycle qualification are implemented here, never in Python.
use crate::meter::{Ledger, MeteredStore, free_bytes};
use anyhow::{Context, Result, anyhow, bail, ensure};
use arrow_row::{RowConverter, SortField};
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
use lance_table::format::Fragment;
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
const MAX_RECEIPT_BYTES: usize = 128 * 1024;

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
    selected_fragment_ids: Vec<u64>,
    reader_tag: String,
    after_tag: String,
    original_tags: BTreeMap<String, u64>,
    journal: String,
    total_write_budget_bytes: u64,
    source_bytes: u64,
    source_rows_digest: String,
    rows_verified: usize,
}

#[derive(Debug)]
struct Wrapper {
    ledger: Arc<Ledger>,
    root: Path,
    delete_paths: Vec<Path>,
}
impl WrappingObjectStore for Wrapper {
    fn wrap(&self, prefix: &str, original: Arc<dyn ObjectStore>) -> Arc<dyn ObjectStore> {
        // Reject unexpected stores, instead of accidentally permitting direct
        // local-writer routes or an external blob/index store.
        assert_eq!(prefix, "file-object-store", "Unexpected store provider");
        Arc::new(
            MeteredStore::new(original, self.ledger.clone(), self.root.clone())
                .with_owned_tag_deletes(self.delete_paths.clone()),
        )
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
        })),
        ..Default::default()
    };
    let dataset = DatasetBuilder::from_uri(&uri)
        .with_store_params(params)
        .load()
        .await?;
    let store = dataset.object_store(None).await?;
    ensure!(
        store.scheme == "file-object-store" && !store.has_direct_local_paths(),
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
    let schema = serde_json::to_value(dataset.schema().to_arrow_schema())?;
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
    let schema = dataset.schema().to_arrow_schema();
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
    for index in dataset.load_indices().await?.iter() {
        ensure!(index.base_id.is_none(), "External index store refused");
        contract.push(json!({"name":index.name,"fields":index.fields,"coveringFields":index.covering_fields,
            "type":index.index_details.as_ref().map(|details| details.type_url.clone()),"version":index.index_version}));
    }
    contract.sort_by_key(Value::to_string);
    Ok(contract)
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
    for index in dataset.load_indices().await?.iter() {
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
            IndexType::IvfFlat
            | IndexType::IvfPq
            | IndexType::IvfSq
            | IndexType::IvfHnswPq
            | IndexType::IvfHnswSq
            | IndexType::IvfHnswFlat => {}
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
        receipt.reader_tag == format!("gmax-native-{}-before", receipt.receipt_id)
            && receipt.after_tag == format!("gmax-native-{}-after", receipt.receipt_id),
        "Unverified protective tag identity"
    );
    Ok(Some(receipt))
}

async fn verify_candidate(before: &Dataset, after: &Dataset, receipt: &Receipt) -> Result<usize> {
    ensure!(
        before.schema().to_arrow_schema() == after.schema().to_arrow_schema(),
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
    emit(json!({"phase":"launch"}))?;
    acknowledge(&request)?;
    verify_owner(&request, &root, true)?;
    check_space(&request, &root, 0)?;
    let previous = read_receipt(&root)?;
    let mut receipt;
    let preliminary = Arc::new(Ledger::new(request.total_write_budget_bytes)?);
    let mut dataset = open(&root, preliminary, vec![]).await?;
    ensure!(
        dataset.version_id() == request.expected_version
            && dataset.latest_version_id().await? == request.expected_version,
        "Table changed before planning"
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
        max_source_bytes: Some(request.source_limit_bytes),
        ..Default::default()
    };
    if request.action == "run" {
        if let Some(previous) = &previous {
            ensure!(
                previous.phase == "finalized",
                "Interrupted receipt exists; explicit recovery required before any new copy"
            );
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
        plan_tasks = plan.compaction_tasks().take(1).collect();
        let selected: Vec<Fragment> = plan
            .tasks
            .iter()
            .take(1)
            .flat_map(|task| task.fragments.iter().cloned())
            .collect();
        if selected.is_empty() {
            let no_work_plan = json!({"protocolVersion":2,"engine":"12.0.0","status":"no-work","action":request.action,
                "expectedVersion":request.expected_version,"beforeVersion":request.expected_version,"planId":sha(b"no-work"),
                "totalWriteBudgetBytes":request.total_write_budget_bytes,"sharedTotalWriteCapBytes":request.total_write_budget_bytes,
                "freeSpaceMarginBytes":request.free_space_margin_bytes,"nativeTotalWriteBudgetEnforced":true,
                "budgetKind":"cumulative-writes","effectiveStoreScheme":"file-object-store"});
            emit(json!({"phase":"ready","plan":no_work_plan}))?;
            acknowledge(&request)?;
            emit(
                json!({"phase":"result","status":"no-work","beforeVersion":request.expected_version,"afterVersion":request.expected_version,
                "planId":sha(b"no-work"),"receiptId":"","totalBytesWritten":0,"dataBytesWritten":0,"indexBytesWritten":0,"metadataBytesWritten":0,"verificationBytesWritten":0,"rowsVerified":0}),
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
        let (rows, digest) = row_digest(&dataset, selected).await?;
        let original_tags = tags(&dataset).await?;
        ensure!(original_tags.len() <= 254, "Tag metadata bound exceeded");
        let receipt_id = request.lease_nonce.clone();
        let plan_id = sha(&serde_json::to_vec(
            &json!({"version":request.expected_version,"selected":ids,"sourceBytes":source_bytes,
            "rowsDigest":digest,"totalWriteBudgetBytes":request.total_write_budget_bytes,"schema":dataset.schema().to_arrow_schema(),
            "fragments":dataset.manifest.fragments,"indices":index_contract(&dataset).await?}),
        )?);
        receipt = Receipt {
            protocol_version: 2,
            phase: "protecting".into(),
            receipt_id: receipt_id.clone(),
            plan_id,
            before_version: request.expected_version,
            after_version: None,
            selected_fragment_ids: ids,
            reader_tag: format!("gmax-native-{receipt_id}-before"),
            after_tag: format!("gmax-native-{receipt_id}-after"),
            original_tags,
            journal: format!("_gmax-maintenance-{receipt_id}.journal"),
            total_write_budget_bytes: request.total_write_budget_bytes,
            source_bytes,
            source_rows_digest: digest,
            rows_verified: rows,
        };
    } else {
        receipt = previous.context("No owned recovery receipt")?;
        ensure!(
            receipt.phase != "finalized",
            "Recovery already finalized; no duplicate operation"
        );
        ensure!(
            receipt.total_write_budget_bytes == request.total_write_budget_bytes,
            "Recovery cannot reset/change write budget"
        );
        ensure!(
            receipt.after_version == Some(request.expected_version),
            "Uncertain/uncommitted or advanced recovery head; no copy retry"
        );
        let protected = tags(&dataset).await?;
        ensure!(
            protected.get(&receipt.reader_tag) == Some(&receipt.before_version)
                && protected.get(&receipt.after_tag) == receipt.after_version.as_ref(),
            "Recovery protected heads changed"
        );
    }
    let proof = json!({"protocolVersion":2,"engine":"12.0.0","status":"qualified","action":request.action,
        "expectedVersion":request.expected_version,"beforeVersion":receipt.before_version,"planId":receipt.plan_id,
        "totalWriteBudgetBytes":request.total_write_budget_bytes,"sharedTotalWriteCapBytes":request.total_write_budget_bytes,
        "freeSpaceMarginBytes":request.free_space_margin_bytes,"nativeTotalWriteBudgetEnforced":true,
        "budgetKind":"cumulative-writes","effectiveStoreScheme":"file-object-store"});
    emit(json!({"phase":"ready","plan":proof}))?;
    acknowledge(&request)?;
    verify_owner(&request, &root, true)?;
    check_space(&request, &root, 0)?;
    let ledger = Arc::new(
        if request.action == "run" {
            Ledger::with_journal(
                request.total_write_budget_bytes,
                &root.join(&receipt.journal),
            )?
        } else {
            Ledger::restore(
                request.total_write_budget_bytes,
                &root.join(&receipt.journal),
            )?
        }
        .with_space_guard(root.clone(), request.free_space_margin_bytes),
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
    dataset = open(&root, ledger.clone(), tag_paths).await?;
    let operation = async {
        ensure!(dataset.version_id() == request.expected_version && dataset.latest_version_id().await? == request.expected_version, "Head changed at write admission");
        if request.action == "run" {
            save_receipt(&dataset, &root, &receipt).await?;
            dataset.tags().create(&receipt.reader_tag, receipt.before_version).await?;
            receipt.phase = "protected".into(); save_receipt(&dataset, &root, &receipt).await?;
        }
        emit(json!({"phase":"protected-read-ready","beforeVersion":receipt.before_version,"planId":receipt.plan_id,"readerTag":receipt.reader_tag,"receiptId":receipt.receipt_id}))?;
        acknowledge(&request)?; verify_owner(&request, &root, false)?;
        if request.action == "run" {
            receipt.phase = "copying".into(); save_receipt(&dataset, &root, &receipt).await?;
            let mut copies = vec![];
            for task in &plan_tasks { copies.push(task.execute(&dataset).await?); }
            verify_owner(&request, &root, false)?;
            ensure!(dataset.latest_version_id().await? == receipt.before_version, "Head changed before compaction commit");
            commit_compaction(&mut dataset, copies, Arc::new(DatasetIndexRemapperOptions::default()), &options).await?;
            receipt.after_version = Some(dataset.version_id());
            dataset.tags().create(&receipt.after_tag, dataset.version_id()).await?;
            receipt.phase = "copied".into(); save_receipt(&dataset, &root, &receipt).await?;
        }
        let before = dataset.checkout_version(receipt.before_version).await?;
        receipt.rows_verified = verify_candidate(&before, &dataset, &receipt).await?;
        receipt.phase = "verified".into(); save_receipt(&dataset, &root, &receipt).await?;
        emit(json!({"phase":"reader-drain","beforeVersion":receipt.before_version,"afterVersion":receipt.after_version,"planId":receipt.plan_id,
            "readerTag":receipt.reader_tag,"receiptId":receipt.receipt_id}))?;
        acknowledge(&request)?; verify_owner(&request, &root, true)?;
        ensure!(dataset.latest_version_id().await? == receipt.after_version.context("Candidate version missing")?, "Head changed before finalization");
        let protected = tags(&dataset).await?;
        ensure!(protected.get(&receipt.reader_tag) == Some(&receipt.before_version) && protected.get(&receipt.after_tag) == receipt.after_version.as_ref(), "Owned protective tag changed");
        let mut expected_tags = receipt.original_tags.clone(); expected_tags.insert(receipt.reader_tag.clone(), receipt.before_version);
        expected_tags.insert(receipt.after_tag.clone(), receipt.after_version.unwrap());
        ensure!(protected == expected_tags, "External protected tags changed");
        dataset.tags().delete(&receipt.reader_tag).await?; dataset.tags().delete(&receipt.after_tag).await?;
        ensure!(tags(&dataset).await? == receipt.original_tags, "External tags changed during finalization");
        receipt.phase = "finalized".into(); save_receipt(&dataset, &root, &receipt).await?;
        let mut result = serde_json::to_value(ledger.counts())?;
        result["phase"] = json!("result"); result["status"] = json!(if request.action == "run" {"committed"} else {"recovered"});
        result["beforeVersion"] = json!(receipt.before_version); result["afterVersion"] = json!(receipt.after_version);
        result["planId"] = json!(receipt.plan_id); result["receiptId"] = json!(receipt.receipt_id);
        result["rowsVerified"] = json!(receipt.rows_verified); emit(result)?;
        Ok::<_, anyhow::Error>(())
    }.await;
    if let Err(error) = operation {
        let mut outcome = serde_json::to_value(ledger.counts())?;
        outcome["phase"] = json!("error");
        outcome["status"] = json!("uncertain");
        outcome["reason"] = json!(error.to_string());
        outcome["receiptId"] = json!(receipt.receipt_id);
        emit(outcome)?;
        return Err(error);
    }
    Ok(())
}

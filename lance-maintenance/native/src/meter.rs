//! One non-refunding allowance for all submitted file payloads in an attempt.
//!
//! This measures payload bytes, not filesystem journals, allocator overhead or
//! physical device writes. Admission must separately reserve free-space margin.
use async_trait::async_trait;
use futures::{FutureExt, StreamExt, stream::BoxStream};
use object_store::{
    CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore,
    PutMultipartOptions, PutOptions, PutPayload, PutResult, RenameOptions, Result, UploadPart,
    path::Path,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub total_bytes_written: u64,
    pub data_bytes_written: u64,
    pub index_bytes_written: u64,
    pub metadata_bytes_written: u64,
    pub verification_bytes_written: u64,
}

#[derive(Debug)]
pub struct Ledger {
    cap: u64,
    state: Mutex<LedgerState>,
    space_guard: Option<(std::path::PathBuf, u64)>,
    finalization_reserve: u64,
    finalization_paths: Vec<Path>,
}
#[derive(Debug)]
struct LedgerState {
    counts: Counts,
    journal: Option<File>,
    poisoned: bool,
    finalizing: bool,
}
const RECORD_BYTES: u64 = 80;

fn refused(reason: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: "gmax-write-budget",
        source: std::io::Error::other(reason.into()).into(),
    }
}

impl Ledger {
    pub fn poison(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.poisoned = true;
        }
    }
    pub fn new(cap: u64) -> Result<Self> {
        if cap == 0 || cap > 512 * 1024 * 1024 {
            return Err(refused("Total write budget must be 1..512 MiB"));
        }
        Ok(Self {
            cap,
            state: Mutex::new(LedgerState {
                counts: Counts::default(),
                journal: None,
                poisoned: false,
                finalizing: false,
            }),
            space_guard: None,
            finalization_reserve: 0,
            finalization_paths: vec![],
        })
    }
    pub fn cap(&self) -> u64 {
        self.cap
    }
    pub fn counts(&self) -> Counts {
        self.state
            .lock()
            .expect("write ledger poisoned")
            .counts
            .clone()
    }
    pub fn with_space_guard(mut self, root: std::path::PathBuf, margin: u64) -> Self {
        self.space_guard = Some((root, margin));
        self
    }
    pub fn with_finalization_reserve(mut self, bytes: u64) -> Self {
        self.finalization_reserve = bytes.min(self.cap);
        self
    }
    pub fn with_finalization_paths(mut self, paths: Vec<Path>) -> Self {
        self.finalization_paths = paths;
        self
    }
    pub fn enter_metadata_finalization(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| refused("Write ledger poisoned"))?;
        if state.poisoned {
            return Err(refused("Uncertain journal cannot finalize"));
        }
        state.finalizing = true;
        Ok(())
    }
    pub fn with_journal(cap: u64, file: &std::path::Path) -> Result<Self> {
        Self::create_journal(cap, file, None)
    }
    pub fn with_guarded_journal(
        cap: u64,
        file: &std::path::Path,
        root: std::path::PathBuf,
        margin: u64,
    ) -> Result<Self> {
        Self::create_journal(cap, file, Some((root, margin)))
    }
    fn create_journal(
        cap: u64,
        file: &std::path::Path,
        guard: Option<(std::path::PathBuf, u64)>,
    ) -> Result<Self> {
        if cap < RECORD_BYTES {
            return Err(refused("Budget cannot fit durable counter record"));
        }
        let mut ledger = Self::new(cap)?;
        ledger.space_guard = guard;
        let journal = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(file)
            .map_err(|error| refused(format!("Create write journal: {error}")))?;
        ledger
            .state
            .get_mut()
            .map_err(|_| refused("Ledger poisoned"))?
            .journal = Some(journal);
        ledger.charge(&Path::from("_gmax-maintenance/journal"), 0)?;
        File::open(
            file.parent()
                .ok_or_else(|| refused("Journal parent missing"))?,
        )
        .and_then(|parent| parent.sync_all())
        .map_err(|error| refused(format!("Journal directory fsync: {error}")))?;
        Ok(ledger)
    }
    pub fn restore(cap: u64, file: &std::path::Path) -> Result<Self> {
        Self::new(cap)?;
        let size = std::fs::symlink_metadata(file).map_err(|error| refused(error.to_string()))?;
        if !size.is_file()
            || size.len() == 0
            || size.len() % RECORD_BYTES != 0
            || size.len() > 80 * 65536
        {
            return Err(refused(
                "Uncertain/truncated write journal; budget cannot reset",
            ));
        }
        let mut reader = File::open(file).map_err(|error| refused(error.to_string()))?;
        let mut counts = Counts::default();
        for _ in 0..size.len() / RECORD_BYTES {
            let mut record = [0u8; RECORD_BYTES as usize];
            reader
                .read_exact(&mut record)
                .map_err(|error| refused(error.to_string()))?;
            if Sha256::digest(&record[..48]).as_slice() != &record[48..] {
                return Err(refused(
                    "Uncertain write journal checksum; budget cannot reset",
                ));
            }
            let values: Vec<u64> = record[..48]
                .chunks_exact(8)
                .map(|field| u64::from_le_bytes(field.try_into().unwrap()))
                .collect();
            let sum = values[2..]
                .iter()
                .try_fold(0u64, |sum, value| sum.checked_add(*value));
            if values[0] != cap
                || values[1] > cap
                || values[1] <= counts.total_bytes_written
                || sum != Some(values[1])
            {
                return Err(refused(
                    "Invalid write journal counters; budget cannot reset",
                ));
            }
            counts = Counts {
                total_bytes_written: values[1],
                data_bytes_written: values[2],
                index_bytes_written: values[3],
                metadata_bytes_written: values[4],
                verification_bytes_written: values[5],
            };
        }
        let journal = OpenOptions::new()
            .append(true)
            .open(file)
            .map_err(|error| refused(error.to_string()))?;
        Ok(Self {
            cap,
            state: Mutex::new(LedgerState {
                counts,
                journal: Some(journal),
                poisoned: false,
                finalizing: false,
            }),
            space_guard: None,
            finalization_reserve: 0,
            finalization_paths: vec![],
        })
    }
    pub fn charge(&self, path: &Path, bytes: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| refused("Write ledger poisoned"))?;
        if state.poisoned {
            return Err(refused(
                "Journal persistence failed; all further writes refused",
            ));
        }
        if let Some((root, margin)) = &self.space_guard {
            let required = self
                .cap
                .checked_sub(state.counts.total_bytes_written)
                .and_then(|remaining| remaining.checked_add(*margin))
                .ok_or_else(|| refused("Invalid remaining free-space reservation"))?;
            if free_bytes(root)? < required {
                return Err(refused(
                    "Fresh free space below remaining write budget plus margin",
                ));
            }
        }
        let journal_bytes = if state.journal.is_some() {
            RECORD_BYTES
        } else {
            0
        };
        let new_total = state
            .counts
            .total_bytes_written
            .checked_add(bytes)
            .and_then(|total| total.checked_add(journal_bytes))
            .ok_or_else(|| refused("Cumulative write counter overflow"))?;
        if new_total > self.cap {
            return Err(refused("Cumulative total write budget exceeded"));
        }
        let name = path.as_ref();
        let owned_metadata =
            self.finalization_paths.contains(path) || name == "_gmax-maintenance/journal";
        if state.finalizing && !owned_metadata {
            return Err(refused("Only owned metadata may write during finalization"));
        }
        if !state.finalizing && new_total > self.cap - self.finalization_reserve {
            return Err(refused(
                "Write would consume reserved finalization metadata budget",
            ));
        }
        let counts = &mut state.counts;
        let category = if name.contains("/_indices/") || name.starts_with("_indices/") {
            &mut counts.index_bytes_written
        } else if name.contains("/data/") || name.starts_with("data/") {
            &mut counts.data_bytes_written
        } else {
            &mut counts.metadata_bytes_written
        };
        *category = category
            .checked_add(bytes)
            .ok_or_else(|| refused("Category counter overflow"))?;
        counts.metadata_bytes_written += journal_bytes;
        counts.total_bytes_written = new_total;
        if state.journal.is_some() {
            let counts = &state.counts;
            let fields = [
                self.cap,
                counts.total_bytes_written,
                counts.data_bytes_written,
                counts.index_bytes_written,
                counts.metadata_bytes_written,
                counts.verification_bytes_written,
            ];
            let mut record = Vec::with_capacity(RECORD_BYTES as usize);
            for value in fields {
                record.extend_from_slice(&value.to_le_bytes());
            }
            record.extend_from_slice(&Sha256::digest(&record));
            // The record's own 80 bytes are included above before touching disk.
            // An append/fsync error refuses the payload write with no refund.
            if let Err(error) = state
                .journal
                .as_mut()
                .unwrap()
                .write_all(&record)
                .and_then(|_| state.journal.as_mut().unwrap().sync_all())
            {
                state.poisoned = true;
                return Err(refused(format!("Persist write charge: {error}")));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
pub fn free_bytes(root: &std::path::Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(root.as_os_str().as_bytes())
        .map_err(|_| refused("Invalid disk path"))?;
    let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let status = unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) };
    if status != 0 {
        return Err(refused(std::io::Error::last_os_error().to_string()));
    }
    let info = unsafe { info.assume_init() };
    (info.f_bavail as u64)
        .checked_mul(info.f_frsize as u64)
        .ok_or_else(|| refused("Free space overflow"))
}

/// Only construct around the pinned LocalFileSystem provider. Its multipart
/// completion renames the single staging file, without writing a second copy.
/// Every payload part is charged before constructing its underlying future.
#[derive(Debug)]
pub struct MeteredStore {
    inner: Arc<dyn ObjectStore>,
    ledger: Arc<Ledger>,
    root: Path,
    delete_paths: Vec<Path>,
    owned: Option<Arc<crate::owned::OwnedWrites>>,
    #[cfg(feature = "qualification")]
    failure_prefix: Option<String>,
}

impl MeteredStore {
    pub fn new(inner: Arc<dyn ObjectStore>, ledger: Arc<Ledger>, root: Path) -> Self {
        Self {
            inner,
            ledger,
            root,
            delete_paths: vec![],
            owned: None,
            #[cfg(feature = "qualification")]
            failure_prefix: None,
        }
    }
    pub fn with_owned_tag_deletes(mut self, paths: Vec<Path>) -> Self {
        self.delete_paths = paths;
        self
    }
    pub fn with_owned_writes(mut self, owned: Arc<crate::owned::OwnedWrites>) -> Self {
        self.owned = Some(owned);
        self
    }
    #[cfg(feature = "qualification")]
    pub fn with_qualification_failure_prefix(mut self, prefix: Option<String>) -> Self {
        self.failure_prefix = prefix;
        self
    }
    fn backend_fault(&self, path: &Path) -> Result<()> {
        #[cfg(feature = "qualification")]
        if self.failure_prefix.as_ref().is_some_and(|prefix| {
            path.prefix_match(&self.root)
                .map(|parts| {
                    parts
                        .map(|part| part.as_ref().to_string())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .is_some_and(|name| name.starts_with(prefix))
        }) {
            return Err(object_store::Error::Generic {
                store: "gmax-qualification-injected-enospc",
                source: std::io::Error::from_raw_os_error(28).into(),
            });
        }
        let _ = path;
        Ok(())
    }
    fn allow(&self, path: &Path) -> Result<()> {
        if path.prefix_match(&self.root).is_none() {
            return Err(refused("Writer escaped table root"));
        }
        Ok(())
    }
}

impl fmt::Display for MeteredStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "GmaxMetered({})", self.inner)
    }
}

#[async_trait]
impl ObjectStore for MeteredStore {
    async fn put_opts(
        &self,
        path: &Path,
        payload: PutPayload,
        options: PutOptions,
    ) -> Result<PutResult> {
        self.allow(path)?;
        if let Some(owned) = &self.owned {
            owned.register(path)?;
        }
        self.ledger.charge(path, payload.content_length() as u64)?;
        self.backend_fault(path)?;
        // Failed conditional puts and failed writes stay charged. No refunds.
        self.inner.put_opts(path, payload, options).await
    }
    async fn put_multipart_opts(
        &self,
        path: &Path,
        options: PutMultipartOptions,
    ) -> Result<Box<dyn MultipartUpload>> {
        self.allow(path)?;
        if let Some(owned) = &self.owned {
            owned.register(path)?;
        }
        let upload = self.inner.put_multipart_opts(path, options).await?;
        let fault = self
            .backend_fault(path)
            .err()
            .map(|error| error.to_string());
        Ok(Box::new(MeteredUpload {
            inner: upload,
            ledger: self.ledger.clone(),
            path: path.clone(),
            failed: false,
            injected_fault: fault,
        }))
    }
    async fn get_opts(&self, path: &Path, options: GetOptions) -> Result<GetResult> {
        self.allow(path)?;
        self.inner.get_opts(path, options).await
    }
    fn delete_stream(
        &self,
        locations: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        // Reclamation belongs to independent prune; this engine may remove only
        // its own protective tag/receipt through explicitly metered overwrites.
        let inner = self.inner.clone();
        let paths = self.delete_paths.clone();
        let ledger = self.ledger.clone();
        locations
            .then(move |location| {
                let inner = inner.clone();
                let paths = paths.clone();
                let ledger = ledger.clone();
                async move {
                    let location = location?;
                    if !paths.contains(&location) {
                        return Err(refused("Delete is outside bounded-copy protocol"));
                    }
                    ledger.charge(&location, 0)?;
                    let mut results =
                        inner.delete_stream(futures::stream::iter(vec![Ok(location)]).boxed());
                    results
                        .next()
                        .await
                        .ok_or_else(|| refused("Missing deletion result"))?
                }
            })
            .boxed()
    }
    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        let prefix = prefix.cloned().unwrap_or_else(|| self.root.clone());
        if let Err(error) = self.allow(&prefix) {
            return futures::stream::once(async { Err(error) }).boxed();
        }
        self.inner.list(Some(&prefix))
    }
    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        let prefix = prefix.unwrap_or(&self.root);
        self.allow(prefix)?;
        self.inner.list_with_delimiter(Some(prefix)).await
    }
    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        self.allow(from)?;
        self.allow(to)?;
        if let Some(owned) = &self.owned {
            owned.register(to)?;
        }
        let source_size = self
            .inner
            .get_opts(from, GetOptions::default().with_head(true))
            .await?
            .meta
            .size;
        self.ledger.charge(to, source_size)?;
        self.backend_fault(to)?;
        self.inner.copy_opts(from, to, options).await
    }
    async fn rename_opts(&self, from: &Path, to: &Path, options: RenameOptions) -> Result<()> {
        self.allow(from)?;
        self.allow(to)?;
        if let Some(owned) = &self.owned {
            owned.check_rename_source(from)?;
            owned.register(to)?;
        }
        let source_size = self
            .inner
            .get_opts(from, GetOptions::default().with_head(true))
            .await?
            .meta
            .size;
        // Conservative even though pinned local rename writes no payload.
        self.ledger.charge(to, source_size)?;
        self.backend_fault(to)?;
        self.inner.rename_opts(from, to, options).await
    }
}

#[derive(Debug)]
struct MeteredUpload {
    inner: Box<dyn MultipartUpload>,
    ledger: Arc<Ledger>,
    path: Path,
    failed: bool,
    injected_fault: Option<String>,
}
#[async_trait]
impl MultipartUpload for MeteredUpload {
    fn put_part(&mut self, payload: PutPayload) -> UploadPart {
        if self.failed {
            return async { Err(refused("Multipart budget already refused")) }.boxed();
        }
        if let Err(error) = self
            .ledger
            .charge(&self.path, payload.content_length() as u64)
        {
            self.failed = true;
            return async { Err(error) }.boxed();
        }
        if let Some(reason) = &self.injected_fault {
            self.failed = true;
            let error = refused(reason.clone());
            return async { Err(error) }.boxed();
        }
        self.inner.put_part(payload)
    }
    async fn complete(&mut self) -> Result<PutResult> {
        if self.failed {
            return Err(refused("Cannot publish budget-refused upload"));
        }
        self.ledger.charge(&self.path, 0)?;
        self.inner.complete().await
    }
    async fn abort(&mut self) -> Result<()> {
        self.inner.abort().await
    }
}

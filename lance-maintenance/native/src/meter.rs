//! One non-refunding allowance for all submitted file payloads in an attempt.
//!
//! This measures payload bytes, not filesystem journals, allocator overhead or
//! physical device writes. Admission must separately reserve free-space margin.
use std::{fmt, sync::{Arc, Mutex}};
use async_trait::async_trait;
use futures::{stream::BoxStream, FutureExt, StreamExt};
use object_store::{path::Path, CopyOptions, GetOptions, GetResult, ListResult,
    MultipartUpload, ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions,
    PutPayload, PutResult, RenameOptions, Result, UploadPart};
use serde::Serialize;

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
    counts: Mutex<Counts>,
}

fn refused(reason: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: "gmax-write-budget",
        source: std::io::Error::other(reason.into()).into(),
    }
}

impl Ledger {
    pub fn new(cap: u64) -> Result<Self> {
        if cap == 0 || cap > 512 * 1024 * 1024 {
            return Err(refused("Total write budget must be 1..512 MiB"));
        }
        Ok(Self { cap, counts: Mutex::new(Counts::default()) })
    }
    pub fn cap(&self) -> u64 { self.cap }
    pub fn counts(&self) -> Counts { self.counts.lock().expect("write ledger poisoned").clone() }
    pub fn charge(&self, path: &Path, bytes: u64) -> Result<()> {
        let mut counts = self.counts.lock().map_err(|_| refused("Write ledger poisoned"))?;
        let new_total = counts.total_bytes_written.checked_add(bytes)
            .ok_or_else(|| refused("Cumulative write counter overflow"))?;
        if new_total > self.cap { return Err(refused("Cumulative total write budget exceeded")); }
        let name = path.as_ref();
        let category = if name.contains("/_indices/") || name.starts_with("_indices/") {
            &mut counts.index_bytes_written
        } else if name.contains("/data/") || name.starts_with("data/") {
            &mut counts.data_bytes_written
        } else { &mut counts.metadata_bytes_written };
        *category = category.checked_add(bytes).ok_or_else(|| refused("Category counter overflow"))?;
        counts.total_bytes_written = new_total;
        Ok(())
    }
}

/// Only construct around the pinned LocalFileSystem provider. Its multipart
/// completion renames the single staging file, without writing a second copy.
/// Every payload part is charged before constructing its underlying future.
#[derive(Debug)]
pub struct MeteredStore {
    inner: Arc<dyn ObjectStore>,
    ledger: Arc<Ledger>,
    root: Path,
}

impl MeteredStore {
    pub fn new(inner: Arc<dyn ObjectStore>, ledger: Arc<Ledger>, root: Path) -> Self {
        Self { inner, ledger, root }
    }
    fn allow(&self, path: &Path) -> Result<()> {
        if path.prefix_match(&self.root).is_none() { return Err(refused("Writer escaped table root")); }
        Ok(())
    }
}

impl fmt::Display for MeteredStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "GmaxMetered({})", self.inner) }
}

#[async_trait]
impl ObjectStore for MeteredStore {
    async fn put_opts(&self, path: &Path, payload: PutPayload, options: PutOptions) -> Result<PutResult> {
        self.allow(path)?;
        self.ledger.charge(path, payload.content_length() as u64)?;
        // Failed conditional puts and failed writes stay charged. No refunds.
        self.inner.put_opts(path, payload, options).await
    }
    async fn put_multipart_opts(&self, path: &Path, options: PutMultipartOptions) -> Result<Box<dyn MultipartUpload>> {
        self.allow(path)?;
        let upload = self.inner.put_multipart_opts(path, options).await?;
        Ok(Box::new(MeteredUpload { inner: upload, ledger: self.ledger.clone(), path: path.clone(), failed: false }))
    }
    async fn get_opts(&self, path: &Path, options: GetOptions) -> Result<GetResult> {
        self.allow(path)?;
        self.inner.get_opts(path, options).await
    }
    fn delete_stream(&self, locations: BoxStream<'static, Result<Path>>) -> BoxStream<'static, Result<Path>> {
        // Reclamation belongs to independent prune; this engine may remove only
        // its own protective tag/receipt through explicitly metered overwrites.
        locations.map(|_| Err(refused("Delete is outside bounded-copy protocol"))).boxed()
    }
    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        let prefix = prefix.cloned().unwrap_or_else(|| self.root.clone());
        if let Err(error) = self.allow(&prefix) { return futures::stream::once(async { Err(error) }).boxed(); }
        self.inner.list(Some(&prefix))
    }
    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        let prefix = prefix.unwrap_or(&self.root);
        self.allow(prefix)?;
        self.inner.list_with_delimiter(Some(prefix)).await
    }
    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        self.allow(from)?; self.allow(to)?;
        let source_size = self.inner.get_opts(from, GetOptions::default().with_head(true)).await?.meta.size;
        self.ledger.charge(to, source_size)?;
        self.inner.copy_opts(from, to, options).await
    }
    async fn rename_opts(&self, from: &Path, to: &Path, options: RenameOptions) -> Result<()> {
        self.allow(from)?; self.allow(to)?;
        let source_size = self.inner.get_opts(from, GetOptions::default().with_head(true)).await?.meta.size;
        // Conservative even though pinned local rename writes no payload.
        self.ledger.charge(to, source_size)?;
        self.inner.rename_opts(from, to, options).await
    }
}

#[derive(Debug)]
struct MeteredUpload {
    inner: Box<dyn MultipartUpload>,
    ledger: Arc<Ledger>,
    path: Path,
    failed: bool,
}
#[async_trait]
impl MultipartUpload for MeteredUpload {
    fn put_part(&mut self, payload: PutPayload) -> UploadPart {
        if self.failed { return async { Err(refused("Multipart budget already refused")) }.boxed(); }
        if let Err(error) = self.ledger.charge(&self.path, payload.content_length() as u64) {
            self.failed = true;
            return async { Err(error) }.boxed();
        }
        self.inner.put_part(payload)
    }
    async fn complete(&mut self) -> Result<PutResult> {
        if self.failed { return Err(refused("Cannot publish budget-refused upload")); }
        self.inner.complete().await
    }
    async fn abort(&mut self) -> Result<()> { self.inner.abort().await }
}

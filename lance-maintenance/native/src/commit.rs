//! Local head resolution is an explicit bounded metadata read. Mutations still
//! use the pinned conditional-create handler through the metered object store.
use futures::{StreamExt, stream::BoxStream};
use lance::dataset::transaction::Transaction;
use lance_io::object_store::ObjectStore;
use lance_table::{
    format::{IndexMetadata, Manifest},
    io::commit::{
        CommitError, CommitHandler, ConditionalPutCommitHandler, ManifestLocation,
        ManifestNamingScheme, ManifestWriter,
    },
};
use object_store::path::Path;
use std::{fs, path::PathBuf};

#[derive(Debug)]
pub struct LocalHeadCommit {
    pub root: PathBuf,
    pub object_root: Path,
}
impl LocalHeadCommit {
    fn locations(&self, base: &Path) -> lance::Result<Vec<ManifestLocation>> {
        if base != &self.object_root {
            return Err(lance::Error::io("Commit escaped table root"));
        }
        let mut locations = Vec::new();
        let mut scheme = None;
        let entries = fs::read_dir(self.root.join("_versions"))?;
        for (count, entry) in entries.enumerate() {
            if count >= 100_000 {
                return Err(lance::Error::io("Manifest metadata count bound"));
            }
            let entry = entry?;
            let filename = entry.file_name();
            let Some(filename) = filename.to_str() else {
                continue;
            };
            let Some(naming_scheme) = ManifestNamingScheme::detect_scheme(filename) else {
                continue;
            };
            let Some(version) = naming_scheme.parse_version(filename) else {
                continue;
            };
            if let Some(previous) = scheme {
                if previous != naming_scheme {
                    return Err(lance::Error::io("Mixed manifest naming schemes refused"));
                }
            }
            scheme = Some(naming_scheme);
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() {
                return Err(lance::Error::io("Unsafe manifest file"));
            }
            locations.push(ManifestLocation {
                version,
                path: naming_scheme.manifest_path(base, version),
                size: Some(metadata.len()),
                naming_scheme,
                e_tag: None,
                identity: None,
            });
        }
        locations.sort_by_key(|location| std::cmp::Reverse(location.version));
        Ok(locations)
    }
}
#[async_trait::async_trait]
impl CommitHandler for LocalHeadCommit {
    fn is_version_not_found_definitive(&self) -> bool {
        true
    }
    fn propagate_commit_error_after_success(&self) -> bool {
        false
    }
    async fn resolve_latest_location(
        &self,
        base: &Path,
        _store: &ObjectStore,
    ) -> lance::Result<ManifestLocation> {
        self.locations(base)?
            .into_iter()
            .next()
            .ok_or_else(|| lance::Error::io("No attached manifest"))
    }
    fn list_manifest_locations<'a>(
        &self,
        base: &Path,
        _store: &'a ObjectStore,
        _descending: bool,
    ) -> BoxStream<'a, lance::Result<ManifestLocation>> {
        match self.locations(base) {
            Ok(locations) => futures::stream::iter(locations.into_iter().map(Ok)).boxed(),
            Err(error) => futures::stream::iter(vec![Err(error)]).boxed(),
        }
    }
    fn list_manifest_locations_since<'a>(
        &self,
        base: &Path,
        store: &'a ObjectStore,
        since: u64,
    ) -> BoxStream<'a, lance::Result<ManifestLocation>> {
        self.list_manifest_locations(base, store, true)
            .filter(move |result| {
                futures::future::ready(
                    result
                        .as_ref()
                        .map(|location| location.version > since)
                        .unwrap_or(true),
                )
            })
            .boxed()
    }
    async fn commit(
        &self,
        manifest: &mut Manifest,
        indices: Option<Vec<IndexMetadata>>,
        base: &Path,
        store: &ObjectStore,
        writer: ManifestWriter,
        naming: ManifestNamingScheme,
        transaction: Option<Transaction>,
    ) -> std::result::Result<ManifestLocation, CommitError> {
        ConditionalPutCommitHandler
            .commit(manifest, indices, base, store, writer, naming, transaction)
            .await
    }
}

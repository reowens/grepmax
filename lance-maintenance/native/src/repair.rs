//! Fragment-selected scalar repair. Existing disjoint segments are immutable.
use crate::engine::{Receipt, Request, all_indices, save_receipt, verify_owner};
use anyhow::{Context, Result, ensure};
use lance::{Dataset, index::DatasetIndexExt};
use lance_index::{
    IndexType,
    scalar::{BuiltinIndexType, ScalarIndexParams, inverted::tokenizer::InvertedIndexParams},
};
use lance_table::format::IndexMetadata;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) const SOURCE: u64 = 8 * 1024 * 1024;
const MERGE_SOURCE: u64 = 128 * 1024 * 1024;
const SEGMENTS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub fragments: Vec<u64>,
    pub name: String,
    pub field: String,
    pub merge: Vec<String>,
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relocation: Option<crate::relocation::Proof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphans: Option<crate::orphans::Proof>,
}
impl Proof {
    pub fn valid(&self) -> bool {
        if let Some(orphan) = &self.orphans {
            return self.fragments.is_empty()
                && self.name.is_empty()
                && self.field.is_empty()
                && self.merge.is_empty()
                && self.output.is_none()
                && self.relocation.is_none()
                && orphan.valid();
        }
        if let Some(relocation) = &self.relocation {
            return self.fragments.len() == 1
                && self.name.is_empty()
                && self.field.is_empty()
                && self.merge.is_empty()
                && self.output.is_none()
                && relocation.valid(self.fragments[0]);
        }
        !self.fragments.is_empty()
            && self.fragments.len() <= if self.merge.is_empty() { 64 } else { 4096 }
            && self.fragments.iter().all(|id| *id <= u32::MAX as u64)
            && matches!(self.field.as_str(), "path" | "content")
            && !self.name.is_empty()
            && self.name.len() <= 256
            && self.merge.len() <= SEGMENTS
            && self
                .merge
                .iter()
                .chain(self.output.iter())
                .all(|id| uuid::Uuid::parse_str(id).is_ok())
    }
}
fn bytes(root: &Path, index: &IndexMetadata) -> Result<u64> {
    let mut todo = vec![root.join("_indices").join(index.uuid.to_string())];
    let (mut total, mut count) = (0u64, 0usize);
    while let Some(path) = todo.pop() {
        count += 1;
        ensure!(count <= 4096, "Index object inventory bound");
        let meta = fs::symlink_metadata(&path)?;
        ensure!(!meta.file_type().is_symlink(), "Symlink index object");
        if meta.is_dir() {
            for entry in fs::read_dir(path)? {
                todo.push(entry?.path());
            }
        } else {
            ensure!(meta.is_file(), "Nonregular index object");
            total = total
                .checked_add(meta.len())
                .context("Index source overflow")?;
        }
    }
    Ok(total)
}
pub(crate) fn params(index: &IndexMetadata, field: &str) -> Result<(IndexType, ScalarIndexParams)> {
    ensure!(
        index.base_id.is_none() && index.fields.len() == 1 && index.covering_fields.is_empty(),
        "Unsupported scalar declaration"
    );
    let details = index
        .index_details
        .as_ref()
        .context("Missing persisted scalar parameters")?;
    if field == "path" {
        ensure!(
            details.type_url.ends_with("BTreeIndexDetails"),
            "Path index is not B-tree"
        );
        Ok((
            IndexType::BTree,
            ScalarIndexParams::for_builtin(BuiltinIndexType::BTree),
        ))
    } else {
        ensure!(
            details.type_url.ends_with("InvertedIndexDetails"),
            "Content index is not inverted"
        );
        let details = lance_index::pbold::InvertedIndexDetails::decode(details.value.as_slice())?;
        let settings = InvertedIndexParams::try_from(&details)?
            .memory_limit_mb(64)
            .num_workers(1);
        Ok((
            IndexType::Inverted,
            ScalarIndexParams::new("inverted".into()).with_params(&settings.to_training_json()?),
        ))
    }
}
pub async fn plan(
    dataset: &Dataset,
    root: &Path,
    request: &Request,
    previous: Option<&Receipt>,
) -> Result<Option<Proof>> {
    let operation = request.operation.as_deref().unwrap_or("repair");
    if operation == "repair-orphans" {
        return crate::orphans::plan(root);
    }
    if operation == "repair" {
        if let Some(proof) = crate::orphans::plan(root)? {
            return Ok(Some(proof));
        }
        if previous
            .and_then(|p| p.repair.as_ref())
            .is_some_and(|p| !p.field.is_empty())
        {
            if let Some(proof) = crate::relocation::plan(dataset, root, request).await? {
                return Ok(Some(proof));
            }
        }
    }
    if operation == "repair-relocate" {
        return crate::relocation::plan(dataset, root, request).await;
    }
    let all = all_indices(dataset).await?;
    ensure!(all.len() <= 512, "Index segment metadata bound");
    let mut groups: BTreeMap<String, Vec<IndexMetadata>> = BTreeMap::new();
    for index in all {
        if index.fields.len() != 1 {
            continue;
        }
        let field = dataset.schema().field_path(index.fields[0])?;
        if field == "path" || field == "content" {
            groups.entry(index.name.clone()).or_default().push(index);
        }
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by_key(|(name, indices)| {
        let covered: BTreeSet<_> = indices
            .iter()
            .filter_map(|i| i.fragment_bitmap.as_ref())
            .flat_map(|b| b.iter())
            .collect();
        (
            dataset
                .manifest
                .fragments
                .iter()
                .filter(|f| !covered.contains(&(f.id as u32)))
                .map(|f| f.id)
                .min()
                .unwrap_or(u64::MAX),
            name.clone(),
        )
    });
    let mut bounded_backlog = false;
    for (name, mut indices) in groups {
        let field = dataset.schema().field_path(indices[0].fields[0])?;
        params(&indices[0], &field)?;
        let mut covered = BTreeSet::new();
        for index in &indices {
            params(index, &field)?;
            ensure!(
                index.index_details == indices[0].index_details,
                "Incompatible scalar segments"
            );
            covered.extend(
                index
                    .fragment_bitmap
                    .as_ref()
                    .context("Unknown scalar coverage")?
                    .iter(),
            );
        }
        // Merge small current segments before adding more. Never include a
        // large base merely to avoid a refusal, or replace a partially stale
        // segment (the SDK correctly rejects partial overlap).
        if indices.len() >= 8 {
            let current: BTreeSet<_> = dataset
                .manifest
                .fragments
                .iter()
                .map(|f| f.id as u32)
                .collect();
            let mut eligible = vec![];
            for index in indices.drain(..) {
                if index
                    .fragment_bitmap
                    .as_ref()
                    .is_some_and(|b| b.iter().all(|id| current.contains(&id)))
                {
                    // The pinned FTS merger finalizes legacy partition layouts
                    // in-place. Such inputs are not immutable bounded merge
                    // sources; keep them intact and build a new segment instead.
                    if field == "content"
                        && !root
                            .join("_indices")
                            .join(index.uuid.to_string())
                            .join("metadata.lance")
                            .is_file()
                    {
                        continue;
                    }
                    let size = bytes(root, &index)?;
                    if size <= MERGE_SOURCE {
                        eligible.push((size, index));
                    }
                }
            }
            eligible.sort_by_key(|(size, _)| *size);
            let mut picked = vec![];
            let mut size = 0;
            for (n, index) in eligible {
                if size + n > MERGE_SOURCE {
                    break;
                }
                size += n;
                picked.push(index);
                if picked.len() == 8 {
                    break;
                }
            }
            if picked.len() >= 2 {
                let fragments = picked
                    .iter()
                    .flat_map(|i| i.fragment_bitmap.as_ref().unwrap().iter().map(u64::from))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                return Ok(Some(Proof {
                    fragments,
                    name,
                    field,
                    merge: picked.iter().map(|i| i.uuid.to_string()).collect(),
                    output: None,
                    relocation: None,
                    orphans: None,
                }));
            }
        }
        // A single unit builds one logical index. The next unit repairs the
        // other field, avoiding duplicate full-row scans within a tight cap.
        let mut fragments = vec![];
        let mut source = 0;
        let mut rows = 0;
        for f in dataset.manifest.fragments.iter() {
            if covered.contains(&(f.id as u32))
                || request
                    .selected_fragment_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&f.id))
            {
                continue;
            }
            let n = f.files.iter().try_fold(0u64, |s, file| {
                Ok::<_, anyhow::Error>(
                    s.checked_add(fs::metadata(root.join("data").join(&file.path))?.len())
                        .context("Source overflow")?,
                )
            })?;
            let live = f
                .physical_rows
                .context("Unknown fragment rows")?
                .saturating_sub(
                    f.deletion_file
                        .as_ref()
                        .and_then(|d| d.num_deleted_rows)
                        .unwrap_or(0),
                );
            if source + n > SOURCE.min(request.source_limit_bytes) || rows + live > 32768 {
                continue;
            }
            source += n;
            rows += live;
            fragments.push(f.id);
            if fragments.len() == 64 {
                break;
            }
        }
        if !fragments.is_empty() {
            if dataset
                .load_indices()
                .await?
                .iter()
                .filter(|i| i.name == name)
                .count()
                >= SEGMENTS
            {
                bounded_backlog = true;
                continue;
            }
            return Ok(Some(Proof {
                fragments,
                name,
                field,
                merge: vec![],
                output: None,
                relocation: None,
                orphans: None,
            }));
        }
    }
    if operation != "repair-indexes" {
        if let Some(proof) = crate::relocation::plan(dataset, root, request).await? {
            return Ok(Some(proof));
        }
    }
    ensure!(
        !bounded_backlog,
        "Logical index segment bound reached; uncovered coverage remains"
    );
    if operation == "repair-indexes" {
        let (fragments, _) = backlog(dataset).await?;
        ensure!(
            fragments == 0,
            "Uncovered fragments exceed bounded index input; partial relocation required"
        );
    }
    Ok(None)
}
pub async fn execute(
    dataset: &mut Dataset,
    root: &Path,
    receipt: &mut Receipt,
    request: &Request,
) -> Result<()> {
    if receipt
        .repair
        .as_ref()
        .is_some_and(|p| p.relocation.is_some())
    {
        return crate::relocation::execute(dataset, root, receipt, request).await;
    }
    let proof = receipt.repair.clone().context("Missing index proof")?;
    let all = all_indices(dataset).await?;
    let example = all
        .iter()
        .find(|index| index.name == proof.name)
        .context("Scalar index disappeared")?;
    let (kind, settings) = params(example, &proof.field)?;
    receipt.phase = "copying".into();
    save_receipt(dataset, root, receipt).await?;
    let segment = if proof.merge.is_empty() {
        dataset
            .create_index_builder(&[&proof.field], kind, &settings)
            .name(proof.name.clone())
            .replace(true)
            .fragments(proof.fragments.iter().map(|id| *id as u32).collect())
            .execute_uncommitted()
            .await?
    } else {
        let selected: Vec<_> = all
            .into_iter()
            .filter(|index| proof.merge.contains(&index.uuid.to_string()))
            .collect();
        ensure!(selected.len() == proof.merge.len(), "Merge source changed");
        dataset.merge_existing_index_segments(selected).await?
    };
    receipt.repair.as_mut().unwrap().output = Some(segment.uuid.to_string());
    // The complete output identity is durable before its manifest publication.
    save_receipt(dataset, root, receipt).await?;
    crate::engine::qualification_checkpoint(request, "after-index-stage")?;
    verify_owner(request, root, false)?;
    ensure!(
        dataset.latest_version_id().await? == receipt.before_version,
        "Head changed before scalar publication"
    );
    dataset
        .commit_existing_index_segments(&proof.name, &proof.field, vec![segment])
        .await?;
    Ok(())
}
pub async fn verify(
    before: &Dataset,
    after: &Dataset,
    receipt: &Receipt,
    proof: &Proof,
) -> Result<usize> {
    ensure!(proof.valid(), "Invalid repair discriminator/proof");
    if proof.orphans.is_some() {
        return crate::orphans::verify(before, after, receipt).await;
    }
    if let Some(relocation) = &proof.relocation {
        return crate::relocation::verify(before, after, receipt, relocation).await;
    }
    ensure!(
        before.schema() == after.schema() && before.manifest.fragments == after.manifest.fragments,
        "Index repair changed data/schema"
    );
    let old = all_indices(before).await?;
    let new = all_indices(after).await?;
    let output = proof
        .output
        .as_ref()
        .context("Committed repair has no staged output identity")?;
    let added = new
        .iter()
        .find(|index| index.uuid.to_string() == *output)
        .context("Staged index absent from current head")?;
    let template = old
        .iter()
        .find(|index| index.name == proof.name)
        .context("Original logical index missing")?;
    ensure!(
        added.name == proof.name
            && added.fields == template.fields
            && added.covering_fields == template.covering_fields
            && added.index_details == template.index_details,
        "Scalar contract changed"
    );
    ensure!(
        added
            .fragment_bitmap
            .as_ref()
            .context("New coverage missing")?
            .iter()
            .map(u64::from)
            .collect::<BTreeSet<_>>()
            == proof.fragments.iter().copied().collect(),
        "Selected scalar coverage changed"
    );
    for original in old {
        if proof.merge.contains(&original.uuid.to_string()) {
            ensure!(
                !new.iter().any(|i| i.uuid == original.uuid),
                "Merged segment remains active"
            );
        } else {
            ensure!(
                new.iter().any(|i| i == &original),
                "Disjoint original segment changed"
            );
        }
    }
    ensure!(
        new.len() + proof.merge.len() == all_indices(before).await?.len() + 1,
        "Unplanned index publication"
    );
    ensure!(
        receipt.before_version == before.version_id(),
        "Repair before identity changed"
    );
    Ok(0)
}

/// Metadata counts are an explicit backlog, not a query/throughput claim.
pub async fn backlog(dataset: &Dataset) -> Result<(usize, usize)> {
    let all = all_indices(dataset).await?;
    let mut fragments = BTreeSet::new();
    let mut rows = 0;
    for field in ["path", "content"] {
        let covered: BTreeSet<_> = all
            .iter()
            .filter(|i| {
                i.fields.len() == 1
                    && dataset
                        .schema()
                        .field_path(i.fields[0])
                        .is_ok_and(|f| f == field)
            })
            .filter_map(|i| i.fragment_bitmap.as_ref())
            .flat_map(|b| b.iter())
            .collect();
        for f in dataset
            .manifest
            .fragments
            .iter()
            .filter(|f| !covered.contains(&(f.id as u32)))
        {
            fragments.insert(f.id);
            rows += f
                .physical_rows
                .context("Unknown backlog row count")?
                .saturating_sub(
                    f.deletion_file
                        .as_ref()
                        .and_then(|d| d.num_deleted_rows)
                        .unwrap_or(0),
                );
        }
    }
    Ok((fragments.len(), rows))
}

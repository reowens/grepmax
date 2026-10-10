//! Atomic partial row movement: append exact values and delete their original
//! addresses in one Update. Existing address-based indexes are never remapped.
use crate::engine::{Receipt, Request, all_indices, row_digest, save_receipt, verify_owner};
use anyhow::{Context, Result, ensure};
use arrow_array::{RecordBatch, RecordBatchIterator, UInt32Array, UInt64Array};
use arrow_row::{RowConverter, SortField};
use arrow_schema::Schema;
use futures::TryStreamExt;
use lance::{
    Dataset,
    dataset::{
        WriteMode, WriteParams,
        write::{CommitBuilder, write_fragments},
    },
    index::DatasetIndexExt,
};
use lance_table::{
    format::Fragment,
    transaction::{Operation, TransactionBuilder},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::Arc,
};

const PAYLOAD: usize = 2 * 1024 * 1024;
const ROWS: usize = 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    pub name: String,
    pub field: String,
    pub uuid: String,
    pub fragments: Vec<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub addresses: Vec<u64>,
    pub digest: String,
    pub updated: Option<Fragment>,
    pub staged: Vec<Fragment>,
    pub publications: Vec<Publication>,
}
impl Proof {
    pub fn valid(&self, source: u64) -> bool {
        self.addresses.len() <= ROWS
            && self.addresses.iter().all(|a| *a >> 32 == source)
            && self
                .addresses
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len()
                == self.addresses.len()
            && (self.digest.is_empty() && self.addresses.is_empty()
                || self.digest.len() == 64 && self.digest.bytes().all(|b| b.is_ascii_hexdigit()))
            && self.staged.len() <= 8
            && self.publications.len() <= 2
            && self.publications.iter().all(|p| {
                matches!(p.field.as_str(), "path" | "content")
                    && uuid::Uuid::parse_str(&p.uuid).is_ok()
            })
    }
}
pub async fn plan(
    dataset: &Dataset,
    root: &Path,
    request: &Request,
) -> Result<Option<crate::repair::Proof>> {
    let all = all_indices(dataset).await?;
    ensure!(
        all.iter()
            .all(|i| i.base_id.is_none() && i.fragment_bitmap.is_some()),
        "Unknown/external relocation index coverage"
    );
    let mut candidates = vec![];
    for f in dataset.manifest.fragments.iter() {
        if request
            .selected_fragment_ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&f.id))
        {
            continue;
        }
        let deleted = f
            .deletion_file
            .as_ref()
            .and_then(|d| d.num_deleted_rows)
            .unwrap_or(0);
        let source = f.files.iter().try_fold(0u64, |s, file| {
            Ok::<_, anyhow::Error>(
                s.checked_add(fs::metadata(root.join("data").join(&file.path))?.len())
                    .context("Source overflow")?,
            )
        })?;
        let uncovered = all.iter().any(|i| {
            i.fields.len() == 1
                && dataset
                    .schema()
                    .field_path(i.fields[0])
                    .is_ok_and(|field| field == "path" || field == "content")
                && i.fragment_bitmap
                    .as_ref()
                    .is_some_and(|b| !b.contains(f.id as u32))
        });
        // Any deletion is eligible here. It also handles uncovered oversized
        // fragments that cannot train a bounded scalar segment directly.
        if deleted > 0
            || uncovered && source > crate::repair::SOURCE.min(request.source_limit_bytes)
        {
            candidates.push((f.id, deleted, source));
        }
    }
    candidates.sort_by_key(|(id, deleted, source)| (std::cmp::Reverse(*deleted), *source, *id));
    if let Some((id, _, _)) = candidates.first() {
        ensure!(
            !dataset.manifest.uses_stable_row_ids(),
            "Partial relocation requires physical row addresses"
        );
        Ok(Some(crate::repair::Proof {
            fragments: vec![*id],
            name: String::new(),
            field: String::new(),
            merge: vec![],
            output: None,
            orphans: None,
            relocation: Some(Proof {
                addresses: vec![],
                digest: String::new(),
                updated: None,
                staged: vec![],
                publications: vec![],
            }),
        }))
    } else {
        Ok(None)
    }
}
fn digest(batches: &[RecordBatch]) -> Result<(usize, String)> {
    let schema = batches.first().context("No relocation rows")?.schema();
    let id_index = schema.index_of("id")?;
    let converter = RowConverter::new(
        schema
            .fields()
            .iter()
            .map(|f| SortField::new(f.data_type().clone()))
            .collect(),
    )?;
    let ids = RowConverter::new(vec![SortField::new(
        schema.field(id_index).data_type().clone(),
    )])?;
    let mut rows = BTreeMap::new();
    let mut decoded = 0;
    for batch in batches {
        let values = converter.convert_columns(batch.columns())?;
        let keys = ids.convert_columns(&[batch.column(id_index).clone()])?;
        for n in 0..batch.num_rows() {
            ensure!(!batch.column(id_index).is_null(n), "Null application ID");
            decoded += values.row(n).as_ref().len();
            ensure!(decoded <= PAYLOAD, "Relocation decoded payload bound");
            ensure!(
                rows.insert(
                    keys.row(n).as_ref().to_vec(),
                    Sha256::digest(values.row(n).as_ref())
                )
                .is_none(),
                "Duplicate relocated ID"
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
pub async fn execute(
    dataset: &mut Dataset,
    root: &Path,
    receipt: &mut Receipt,
    request: &Request,
) -> Result<()> {
    let source = receipt.selected_fragment_ids[0];
    let fragment = dataset
        .get_fragment(source as usize)
        .context("Relocation source missing")?;
    let mut scanner = fragment.scan();
    scanner
        .with_row_address()
        .batch_size(64)
        .batch_size_bytes(256 * 1024)
        .io_buffer_size(1024 * 1024)
        .limit(Some(ROWS as i64), None)?;
    let columns: Vec<_> = (0..Schema::from(dataset.schema()).fields().len()).collect();
    let mut stream = scanner.try_into_stream().await?;
    let mut batches = vec![];
    let mut addresses = vec![];
    let mut memory = 0;
    while let Some(batch) = stream.try_next().await? {
        let projected = batch.project(&columns)?;
        ensure!(
            projected.get_array_memory_size() <= 64 * 1024 * 1024,
            "Decoded scan batch exceeds memory bound"
        );
        // Scanner slices can retain a whole page's buffers. Materialize only
        // the selected prefix, and shrink a dense batch before refusing it.
        let mut chosen = projected.num_rows();
        let payload = loop {
            let offsets = UInt32Array::from_iter_values(0..chosen as u32);
            let copied = RecordBatch::try_new(
                projected.schema(),
                projected
                    .columns()
                    .iter()
                    .map(|column| arrow_select::take::take(column, &offsets, None))
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            )?;
            if memory + copied.get_array_memory_size() <= PAYLOAD {
                break Some(copied);
            }
            if chosen == 1 {
                break None;
            }
            chosen = (chosen / 2).max(1);
        };
        let Some(payload) = payload else {
            ensure!(
                !batches.is_empty(),
                "One row exceeds relocation payload bound"
            );
            break;
        };
        let next = payload.get_array_memory_size();
        let rowaddr = batch
            .column_by_name("_rowaddr")
            .context("Physical row address absent")?
            .as_any()
            .downcast_ref::<UInt64Array>()
            .context("Physical address type changed")?;
        addresses.extend(rowaddr.values().iter().take(chosen).copied());
        memory += next;
        batches.push(payload);
        if chosen < projected.num_rows() {
            break;
        }
    }
    drop(stream);
    if addresses.is_empty() {
        // An entirely deleted source needs no copying or retraining.
        ensure!(
            fragment.count_rows(None).await? == 0,
            "Empty relocation selection with live source"
        );
    }
    let (rows, hash) = if batches.is_empty() {
        (0, format!("{:x}", Sha256::digest([])))
    } else {
        digest(&batches)?
    };
    receipt.rows_verified = rows;
    receipt.source_rows_digest = hash.clone();
    {
        let proof = receipt
            .repair
            .as_mut()
            .unwrap()
            .relocation
            .as_mut()
            .unwrap();
        proof.addresses = addresses.clone();
        proof.digest = hash;
    }
    receipt.phase = "copying".into();
    save_receipt(dataset, root, receipt).await?;
    let staged = if batches.is_empty() {
        vec![]
    } else {
        let reader = RecordBatchIterator::new(
            batches.into_iter().map(Ok),
            Arc::new(Schema::from(dataset.schema())),
        );
        let transaction = write_fragments(
            Arc::new(dataset.clone()),
            reader,
            WriteParams {
                mode: WriteMode::Append,
                max_rows_per_group: 64,
                max_rows_per_file: ROWS,
                max_bytes_per_file: PAYLOAD,
                ..Default::default()
            },
        )
        .await?;
        let Operation::Append { fragments } = transaction.operation else {
            anyhow::bail!("Unexpected staged write operation")
        };
        fragments
    };
    if !staged.is_empty() {
        let candidate = row_digest(dataset, staged.clone()).await?;
        ensure!(
            candidate.0 == rows && candidate.1 == receipt.source_rows_digest,
            "Uncommitted relocated values differ"
        );
    }
    let updated = if addresses.is_empty() {
        None
    } else {
        let predicate = format!(
            "_rowaddr IN ({})",
            addresses
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
        fragment
            .delete(&predicate)
            .await?
            .map(|f| f.metadata().clone())
    };
    {
        let proof = receipt
            .repair
            .as_mut()
            .unwrap()
            .relocation
            .as_mut()
            .unwrap();
        proof.updated = updated.clone();
        proof.staged = staged.clone();
    }
    save_receipt(dataset, root, receipt).await?;
    crate::engine::qualification_checkpoint(request, "after-relocation-stage")?;
    verify_owner(request, root, false)?;
    ensure!(
        dataset.latest_version_id().await? == receipt.before_version,
        "Head changed before relocation publication"
    );
    let operation = Operation::Update {
        removed_fragment_ids: if updated.is_none() {
            vec![source]
        } else {
            vec![]
        },
        updated_fragments: updated.into_iter().collect(),
        new_fragments: staged,
        fields_modified: vec![],
        compacted_sstables: vec![],
        fields_for_preserving_frag_bitmap: vec![],
        update_mode: None,
        inserted_rows_filter: None,
        updated_fragment_offsets: None,
    };
    *dataset = CommitBuilder::new(Arc::new(dataset.clone()))
        .execute(TransactionBuilder::new(dataset.version_id(), operation).build())
        .await?;
    crate::engine::qualification_checkpoint(request, "after-data-commit")?;
    receipt.after_version = Some(dataset.version_id());
    save_receipt(dataset, root, receipt).await?;
    // Every intermediate head is valid. Persist each staged scalar UUID before
    // publication so recovery can prove either the data-only or indexed head.
    let replacements: Vec<_> = dataset
        .manifest
        .fragments
        .iter()
        .filter(|f| {
            !receipt.selected_fragment_ids.contains(&f.id)
                && receipt
                    .repair
                    .as_ref()
                    .unwrap()
                    .relocation
                    .as_ref()
                    .unwrap()
                    .staged
                    .iter()
                    .any(|s| s.files == f.files)
        })
        .map(|f| f.id)
        .collect();
    for field in ["path", "content"] {
        if replacements.is_empty() {
            break;
        }
        let all = all_indices(dataset).await?;
        let examples: Vec<_> = all
            .iter()
            .filter(|i| {
                i.fields.len() == 1
                    && dataset
                        .schema()
                        .field_path(i.fields[0])
                        .is_ok_and(|s| s == field)
            })
            .collect();
        ensure!(
            examples.len() <= 1 || examples.iter().all(|i| i.name == examples[0].name),
            "Multiple logical scalar indexes on relocation field"
        );
        let Some(example) = examples.first() else {
            continue;
        };
        ensure!(examples.len() < 64, "Relocation index segment bound");
        let name = example.name.clone();
        let (kind, settings) = crate::repair::params(example, field)?;
        let head = dataset.version_id();
        let segment = dataset
            .create_index_builder(&[field], kind, &settings)
            .name(name.clone())
            .replace(true)
            .fragments(replacements.iter().map(|id| *id as u32).collect())
            .execute_uncommitted()
            .await?;
        receipt
            .repair
            .as_mut()
            .unwrap()
            .relocation
            .as_mut()
            .unwrap()
            .publications
            .push(Publication {
                name: name.clone(),
                field: field.into(),
                uuid: segment.uuid.to_string(),
                fragments: replacements.clone(),
            });
        save_receipt(dataset, root, receipt).await?;
        verify_owner(request, root, false)?;
        ensure!(
            dataset.latest_version_id().await? == head,
            "Head changed before relocation index commit"
        );
        dataset
            .commit_existing_index_segments(&name, field, vec![segment])
            .await?;
        crate::engine::qualification_checkpoint(request, &format!("after-{field}-commit"))?;
        receipt.after_version = Some(dataset.version_id());
        save_receipt(dataset, root, receipt).await?;
    }
    Ok(())
}
pub async fn verify(
    before: &Dataset,
    after: &Dataset,
    receipt: &Receipt,
    proof: &Proof,
) -> Result<usize> {
    ensure!(
        before.schema() == after.schema(),
        "Relocation schema changed"
    );
    let source = receipt.selected_fragment_ids[0];
    let old: BTreeMap<_, _> = before
        .manifest
        .fragments
        .iter()
        .map(|f| (f.id, f))
        .collect();
    let new: BTreeMap<_, _> = after.manifest.fragments.iter().map(|f| (f.id, f)).collect();
    for (id, fragment) in &old {
        if *id == source {
            ensure!(
                new.get(id).copied() == proof.updated.as_ref(),
                "Relocation source deletion changed"
            );
        } else {
            ensure!(
                new.get(id) == Some(fragment),
                "Unselected relocation fragment changed"
            );
        }
    }
    let replacements: Vec<_> = new
        .values()
        .filter(|f| !old.contains_key(&f.id))
        .map(|f| (*f).clone())
        .collect();
    ensure!(
        replacements.len() == proof.staged.len()
            && replacements
                .iter()
                .all(|f| proof.staged.iter().any(|s| s.files == f.files
                    && s.physical_rows == f.physical_rows
                    && f.deletion_file.is_none())),
        "Unplanned relocated output"
    );
    let candidate = if replacements.is_empty() {
        (0, format!("{:x}", Sha256::digest([])))
    } else {
        row_digest(after, replacements).await?
    };
    ensure!(
        candidate.0 == proof.addresses.len()
            && candidate.1 == proof.digest
            && candidate.1 == receipt.source_rows_digest,
        "Relocated all-field proof changed"
    );
    // Check the saved row identities against the protected source, in bounded
    // batches. This also prevents a forged address list from authorizing loss.
    ensure!(
        before.get_fragment(source as usize).is_some(),
        "Protected source missing"
    );
    let mut original = vec![];
    for addresses in proof.addresses.chunks(64) {
        // FileFragment.take uses *logical* positions after deletion filtering.
        // Dataset.take_rows resolves physical row IDs for this non-stable table.
        original.push(before.take_rows(addresses, before.schema().clone()).await?);
    }
    if !original.is_empty() {
        ensure!(
            digest(&original)? == candidate,
            "Protected selected rows differ"
        );
    }
    ensure!(
        before.count_rows(None).await? == after.count_rows(None).await?,
        "Relocation live row count changed"
    );
    let indices = all_indices(after).await?;
    for old_index in all_indices(before).await? {
        let expected: BTreeSet<_> = old_index
            .fragment_bitmap
            .as_ref()
            .context("Unknown original coverage")?
            .iter()
            .filter(|id| new.contains_key(&(*id as u64)))
            .collect();
        if expected.is_empty() && !indices.iter().any(|i| i.uuid == old_index.uuid) {
            continue;
        }
        let found = indices
            .iter()
            .find(|i| i.uuid == old_index.uuid)
            .context("Original index lost during relocation")?;
        ensure!(
            found.name == old_index.name
                && found.fields == old_index.fields
                && found.index_details == old_index.index_details,
            "Original index contract changed"
        );
        let original: BTreeSet<_> = old_index
            .fragment_bitmap
            .as_ref()
            .context("Unknown original coverage")?
            .iter()
            .collect();
        let actual: BTreeSet<_> = found
            .fragment_bitmap
            .as_ref()
            .context("Original index coverage lost")?
            .iter()
            .collect();
        // Update may retain bits naming a retired source. Only their effective
        // intersection contributes coverage; no old segment may claim a new
        // replacement address, or lose coverage for a surviving fragment.
        ensure!(
            actual.is_subset(&original)
                && actual
                    .iter()
                    .copied()
                    .filter(|id| new.contains_key(&(*id as u64)))
                    .collect::<BTreeSet<_>>()
                    == expected,
            "Original coverage changed outside removed source"
        );
    }
    let old_ids: BTreeSet<_> = all_indices(before).await?.iter().map(|i| i.uuid).collect();
    for index in indices.iter().filter(|i| !old_ids.contains(&i.uuid)) {
        let publication = proof
            .publications
            .iter()
            .find(|p| p.uuid == index.uuid.to_string())
            .context("Unknown relocation index publication")?;
        ensure!(
            index.name == publication.name
                && index
                    .fragment_bitmap
                    .as_ref()
                    .context("New scalar coverage missing")?
                    .iter()
                    .map(u64::from)
                    .collect::<BTreeSet<_>>()
                    == publication.fragments.iter().copied().collect(),
            "Relocation scalar coverage changed"
        );
    }
    Ok(candidate.0)
}

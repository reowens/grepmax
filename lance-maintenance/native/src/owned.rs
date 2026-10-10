//! Durable ownership of initially absent payload objects. This is deliberately
//! narrower than garbage collection: only this attempt's exact data/index
//! targets and the pinned local provider's numeric staging names may be removed.
use crate::meter::Ledger;
use object_store::{Result, path::Path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_TARGETS: usize = 256;
const MAX_CLEANUP_FILES: usize = 1024;

fn refused(reason: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: "gmax-owned-writes",
        source: std::io::Error::other(reason.into()).into(),
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    path: String,
    checksum: String,
}
#[derive(Debug)]
struct State {
    file: File,
    targets: BTreeSet<Path>,
    bytes: u64,
}
#[derive(Debug)]
pub struct OwnedWrites {
    ledger: Arc<Ledger>,
    root: Path,
    physical_root: PathBuf,
    log: Path,
    state: Mutex<State>,
}
impl OwnedWrites {
    pub fn create(ledger: Arc<Ledger>, root: PathBuf, basename: &str) -> Result<Self> {
        let object_root = Path::from_absolute_path(&root).map_err(|e| refused(e.to_string()))?;
        let log = object_root.child(basename);
        // Charge the durable empty-log creation before touching the backend.
        ledger.charge(&log, 0)?;
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(root.join(basename))
            .map_err(|e| refused(e.to_string()))?;
        file.sync_all()
            .and_then(|_| File::open(&root)?.sync_all())
            .map_err(|e| refused(e.to_string()))?;
        Ok(Self {
            ledger,
            root: object_root,
            physical_root: root,
            log,
            state: Mutex::new(State {
                file,
                targets: BTreeSet::new(),
                bytes: 0,
            }),
        })
    }
    pub fn restore(ledger: Arc<Ledger>, root: PathBuf, basename: &str) -> Result<Self> {
        let file_path = root.join(basename);
        let meta = fs::symlink_metadata(&file_path).map_err(|e| refused(e.to_string()))?;
        if !meta.is_file() || meta.len() > MAX_LOG_BYTES {
            return Err(refused("Uncertain ownership log"));
        }
        let bytes = fs::read(&file_path).map_err(|e| refused(e.to_string()))?;
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            return Err(refused("Truncated ownership log"));
        }
        let object_root = Path::from_absolute_path(&root).map_err(|e| refused(e.to_string()))?;
        let mut targets = BTreeSet::new();
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let record: Record =
                serde_json::from_slice(line).map_err(|e| refused(e.to_string()))?;
            if record.checksum != format!("{:x}", Sha256::digest(record.path.as_bytes())) {
                return Err(refused("Ownership checksum mismatch"));
            }
            let path = Path::parse(&record.path).map_err(|e| refused(e.to_string()))?;
            if !Self::payload(&object_root, &path)
                || !targets.insert(path)
                || targets.len() > MAX_TARGETS
            {
                return Err(refused("Invalid ownership target"));
            }
        }
        let file = OpenOptions::new()
            .append(true)
            .open(file_path)
            .map_err(|e| refused(e.to_string()))?;
        Ok(Self {
            ledger,
            log: object_root.child(basename),
            root: object_root,
            physical_root: root,
            state: Mutex::new(State {
                file,
                targets,
                bytes: meta.len(),
            }),
        })
    }
    fn payload(root: &Path, path: &Path) -> bool {
        path.prefix_match(root)
            .and_then(|mut parts| parts.next())
            .is_some_and(|part| matches!(part.as_ref(), "data" | "_indices" | "_deletions"))
            && path.filename().is_some_and(|name| !name.contains('#'))
    }
    fn physical(&self, path: &Path) -> Result<PathBuf> {
        let parts = path
            .prefix_match(&self.root)
            .ok_or_else(|| refused("Ownership escaped root"))?;
        let mut physical = self.physical_root.clone();
        for part in parts {
            physical.push(part.as_ref());
        }
        let mut ancestor = physical.parent();
        while let Some(parent) = ancestor {
            if parent == self.physical_root {
                break;
            }
            match fs::symlink_metadata(parent) {
                Ok(meta) if !meta.is_dir() => return Err(refused("Unsafe ownership ancestor")),
                Ok(_) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(refused(e.to_string())),
            }
            ancestor = parent.parent();
        }
        Ok(physical)
    }
    fn staging(path: &FsPath) -> Result<Vec<PathBuf>> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| refused("Invalid target name"))?;
        let prefix = format!("{name}#");
        let mut result = Vec::new();
        let Some(parent) = path.parent() else {
            return Err(refused("No target parent"));
        };
        match fs::read_dir(parent) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(|e| refused(e.to_string()))?;
                    let entry_name = entry.file_name();
                    if let Some(suffix) = entry_name.to_str().and_then(|s| s.strip_prefix(&prefix))
                    {
                        if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                            result.push(entry.path());
                            if result.len() > MAX_CLEANUP_FILES {
                                return Err(refused("Staging cleanup bound exceeded"));
                            }
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(refused(e.to_string())),
        }
        Ok(result)
    }
    pub fn register(&self, path: &Path) -> Result<()> {
        if !Self::payload(&self.root, path) {
            return Ok(());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| refused("Ownership lock poisoned"))?;
        if state.targets.contains(path) {
            return Ok(());
        }
        if state.targets.len() >= MAX_TARGETS {
            return Err(refused("Owned object count bound exceeded"));
        }
        let physical = self.physical(path)?;
        match fs::symlink_metadata(&physical) {
            Ok(_) => return Err(refused("Refusing overwrite of pre-existing payload")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(refused(e.to_string())),
        }
        if !Self::staging(&physical)?.is_empty() {
            return Err(refused("Pre-existing payload staging object"));
        }
        let name = path.to_string();
        if name.len() > 1024
            || path
                .prefix_match(&self.root)
                .is_none_or(|parts| parts.count() > 8)
        {
            return Err(refused("Owned target path too long"));
        }
        let record = Record {
            checksum: format!("{:x}", Sha256::digest(name.as_bytes())),
            path: name,
        };
        let mut bytes = serde_json::to_vec(&record).map_err(|e| refused(e.to_string()))?;
        bytes.push(b'\n');
        if state.bytes + bytes.len() as u64 > MAX_LOG_BYTES {
            return Err(refused("Owned log size bound exceeded"));
        }
        self.ledger.charge(&self.log, bytes.len() as u64)?;
        if let Err(e) = state
            .file
            .write_all(&bytes)
            .and_then(|_| state.file.sync_all())
        {
            self.ledger.poison();
            return Err(refused(format!("Persist ownership: {e}")));
        }
        state.bytes += bytes.len() as u64;
        state.targets.insert(path.clone());
        Ok(())
    }
    pub fn check_rename_source(&self, path: &Path) -> Result<()> {
        let payload_directory = path
            .prefix_match(&self.root)
            .and_then(|mut parts| parts.next())
            .is_some_and(|part| matches!(part.as_ref(), "data" | "_indices" | "_deletions"));
        if payload_directory
            && !self
                .state
                .lock()
                .map_err(|_| refused("Ownership lock poisoned"))?
                .targets
                .contains(path)
        {
            return Err(refused("Cannot rename a pre-existing live payload"));
        }
        Ok(())
    }
    pub fn referenced_by(&self, references: &[Path]) -> Result<bool> {
        let state = self
            .state
            .lock()
            .map_err(|_| refused("Ownership lock poisoned"))?;
        Ok(state.targets.iter().any(|target| {
            references
                .iter()
                .any(|reference| target == reference || target.prefix_match(reference).is_some())
        }))
    }
    /// Call only after proving no rewrite was committed and draining readers.
    /// Records were durable before target/staging creation, and each target was
    /// absent from all preceding heads; missing objects make restart idempotent.
    pub fn cleanup_proven_abort(&self) -> Result<usize> {
        let targets = self
            .state
            .lock()
            .map_err(|_| refused("Ownership lock poisoned"))?
            .targets
            .clone();
        let mut files = BTreeSet::new();
        for target in targets {
            let physical = self.physical(&target)?;
            match fs::symlink_metadata(&physical) {
                Ok(meta) if meta.is_file() => {
                    files.insert(physical.clone());
                }
                Ok(_) => return Err(refused("Owned target is not regular")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(refused(e.to_string())),
            }
            for staging in Self::staging(&physical)? {
                files.insert(staging);
            }
        }
        if files.len() > MAX_CLEANUP_FILES {
            return Err(refused("Owned cleanup count bound exceeded"));
        }
        // Validate every object before the first unlink; never follow symlinks.
        for path in &files {
            if !fs::symlink_metadata(path)
                .map_err(|e| refused(e.to_string()))?
                .is_file()
            {
                return Err(refused("Unsafe owned staging object"));
            }
        }
        for path in &files {
            self.ledger
                .charge(&Path::from("_gmax-maintenance/journal"), 0)?;
            fs::remove_file(path)
                .and_then(|_| File::open(path.parent().unwrap())?.sync_all())
                .map_err(|e| refused(format!("Owned cleanup: {e}")))?;
        }
        // Remove only now-empty index directories below this table's _indices.
        for path in &files {
            let mut parent = path.parent();
            while let Some(directory) = parent {
                if directory == self.physical_root.join("_indices")
                    || directory == self.physical_root.join("data")
                {
                    break;
                }
                self.ledger
                    .charge(&Path::from("_gmax-maintenance/journal"), 0)?;
                match fs::remove_dir(directory) {
                    Ok(_) => {
                        File::open(directory.parent().unwrap())
                            .and_then(|f| f.sync_all())
                            .map_err(|e| refused(e.to_string()))?;
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::DirectoryNotEmpty
                            || e.kind() == std::io::ErrorKind::NotFound =>
                    {
                        break;
                    }
                    Err(e) => return Err(refused(e.to_string())),
                }
                parent = directory.parent();
            }
        }
        Ok(files.len())
    }
}

//! Local chunk cache sitting in front of the object store.
//!
//! Chunks are immutable and content-addressed, so a cached chunk is never
//! stale: presence in the cache is sufficient, no validation needed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use parking_lot::Mutex;

use crate::error::Result;
use crate::storage::backend::Backend;
use crate::storage::chunk::ChunkId;

pub struct ChunkStore {
    dir: PathBuf,
    backend: Backend,
    /// Chunks written locally but not yet durable in the object store. The WAL
    /// cannot be checkpointed past a metadata state that references any of these.
    dirty: Arc<Mutex<BTreeSet<ChunkId>>>,
}

impl ChunkStore {
    pub fn new(dir: &Path, backend: Backend) -> Result<ChunkStore> {
        std::fs::create_dir_all(dir)?;
        Ok(ChunkStore { dir: dir.to_path_buf(), backend, dirty: Arc::new(Mutex::new(BTreeSet::new())) })
    }

    fn local(&self, id: ChunkId) -> PathBuf {
        let hex = id.to_hex();
        self.dir.join(&hex[0..2]).join(&hex[2..])
    }

    fn object_key(id: ChunkId) -> String {
        format!("chunks/{}", id.key())
    }

    pub fn is_cached(&self, id: ChunkId) -> bool {
        self.local(id).exists()
    }

    /// Store bytes and return their content hash. Durable locally on return;
    /// the flusher makes it durable in the object store later.
    ///
    /// The file work happens on a blocking thread: it is small but not free,
    /// and a write path that stalls a runtime worker stops every other
    /// connection this server is handling.
    pub async fn put(&self, data: &[u8]) -> Result<ChunkId> {
        let id = ChunkId::of(data);
        let path = self.local(id);
        if !path.exists() {
            // Write-then-rename so a crash never leaves a short chunk under a
            // name that claims to be its hash.
            let data = data.to_vec();
            let path2 = path.clone();
            blocking(move || install(&path2, &data)).await?;
        }
        self.dirty.lock().insert(id);
        Ok(id)
    }

    /// Fetch a chunk, from cache if possible, otherwise from the object store.
    pub async fn get(&self, id: ChunkId) -> Result<Bytes> {
        let path = self.local(id);
        let cached = {
            let path = path.clone();
            blocking(move || Ok(std::fs::read(&path).ok())).await?
        };
        if let Some(data) = cached {
            return Ok(Bytes::from(data));
        }
        let data = self.backend.get(&Self::object_key(id)).await?;
        let (path2, copy) = (path.clone(), data.to_vec());
        blocking(move || install(&path2, &copy)).await?;
        Ok(data)
    }

    pub fn dirty_chunks(&self) -> Vec<ChunkId> {
        self.dirty.lock().iter().copied().collect()
    }

    /// Upload the given chunks, then drop them from the dirty set. Uploading a
    /// chunk twice is harmless — same content, same name.
    pub async fn upload(&self, ids: &[ChunkId]) -> Result<usize> {
        let mut done = 0;
        for &id in ids {
            let data = match std::fs::read(self.local(id)) {
                Ok(d) => Bytes::from(d),
                // Not local: it came from the object store, so it is already there.
                Err(_) => {
                    self.dirty.lock().remove(&id);
                    continue;
                }
            };
            self.backend.put(&Self::object_key(id), data).await?;
            self.dirty.lock().remove(&id);
            done += 1;
        }
        Ok(done)
    }

    /// After recovery, anything the metadata references that is only in the
    /// local cache must be treated as not-yet-uploaded.
    pub fn mark_dirty_if_local(&self, ids: &[ChunkId]) {
        let mut dirty = self.dirty.lock();
        for &id in ids {
            if self.local(id).exists() {
                dirty.insert(id);
            }
        }
    }
}

/// Run blocking file work off the async runtime's worker threads.
async fn blocking<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| crate::error::FsError::Backend(format!("blocking task failed: {e}")))?
}

/// Materialise a chunk at its final path via a uniquely-named temporary.
///
/// The temporary name must be unique per call: concurrent readers can race to
/// populate the same chunk, and a shared temporary name means one of them
/// renames the file out from under the other.
fn install(path: &Path, data: &[u8]) -> Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, data)?;
    // Rename is atomic, so a reader either sees no chunk or the whole one.
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

//! The filesystem engine: POSIX-ish semantics over the storage engine.
//!
//! This is the middle layer. It knows about inodes, chunks, and the WAL. It
//! does not know that NFS exists, and the storage layer below it does not know
//! that this layer exists.

pub mod api;
pub mod passthrough;
pub mod vektor;

pub use api::FileSystem;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::Mutex;

use crate::error::{FsError, Result};
use crate::storage::backend::Backend;
use crate::storage::cache::ChunkStore;
use crate::storage::chunk::{split_range, CHUNK_SIZE};
use crate::storage::meta::{Attr, Body, Ino, Kind, MetaStore, Op, SetAttr, Timespec, ROOT_INO};
use crate::storage::wal::Wal;

const SNAPSHOT_POINTER: &str = "meta/CURRENT";

/// WAL bytes after which the flusher checkpoints even if the timer has not fired.
const CHECKPOINT_BYTES: u64 = 32 * 1024 * 1024;

struct Core {
    wal: Wal,
    meta: MetaStore,
}

impl Core {
    /// Append a batch to the log and apply it to the state machine.
    ///
    /// This does *not* make anything durable — the caller must then wait on
    /// [`Volume::sync_through`] before acknowledging. Callers validate first,
    /// under this same lock, so `apply` cannot legitimately fail here: a
    /// failure means the log and the state machine have diverged, which would
    /// corrupt recovery.
    fn append_and_apply(&mut self, ops: &[Op]) -> Result<()> {
        self.wal.append(ops)?;
        for op in ops {
            self.meta.apply(op).map_err(|e| {
                FsError::Corrupt(format!("committed op rejected by state machine: {e}"))
            })?;
        }
        Ok(())
    }
}

/// Group commit state.
///
/// One fsync costs milliseconds — far more than everything else a write does
/// put together — so a sync performed by one writer is made to count for every
/// writer whose records reached the log before it started.
struct SyncState {
    file: Arc<std::fs::File>,
    /// Highest batch number known to be durable.
    synced: u64,
}

pub struct Volume {
    core: Mutex<Core>,
    sync: Mutex<SyncState>,
    /// Batches appended to the log so far. Read without the core lock so a
    /// syncing task never has to wait on a writing one.
    appended: AtomicU64,
    /// Per-inode locks, held across the read-modify-write of a partial chunk.
    /// Writes to different files then proceed in parallel, and — more
    /// importantly — one writer can build its chunks while another is stuck in
    /// fsync, which is what makes group commit worth anything.
    inode_locks: parking_lot::Mutex<HashMap<Ino, Arc<Mutex<()>>>>,
    chunks: Arc<ChunkStore>,
    backend: Backend,
    state_dir: PathBuf,
    name: String,
    filesystem_id: u64,
    /// Owner stamped on newly created inodes. NFSv3 AUTH_SYS credentials are
    /// not plumbed through to the VFS, so a volume-wide owner is what we have;
    /// without it everything would be created as uid 0 and be unwritable by the
    /// user who mounted it.
    owner: (u32, u32),
}

#[derive(Debug, Clone, Copy)]
pub struct Stats {
    pub inodes: usize,
    pub wal_bytes: u64,
    pub dirty_chunks: usize,
}

impl Volume {
    /// Open a volume: load the last checkpoint from the object store, then
    /// replay the local WAL on top of it.
    pub async fn open(backend_url: &str, state_dir: &Path) -> Result<Arc<Volume>> {
        std::fs::create_dir_all(state_dir)?;
        let backend = Backend::open(backend_url)?;
        let filesystem_id = stable_filesystem_id(backend.url());

        let owner = owner_of(state_dir);

        let mut meta = match load_snapshot(&backend).await {
            Ok(Some(m)) => {
                tracing::info!("recovered checkpoint: {} inodes", m.len());
                m
            }
            Ok(None) => {
                tracing::info!("no checkpoint found, initialising empty volume");
                let mut meta = MetaStore::new();
                // Fresh volume: hand the root to whoever owns the state
                // directory, so the mounting user can write to it.
                if let Ok(root) = meta.get_mut(ROOT_INO) {
                    root.uid = owner.0;
                    root.gid = owner.1;
                }
                meta
            }
            Err(e) => return Err(e),
        };

        let (wal, ops) = Wal::open(&state_dir.join("wal"))?;
        let replayed = ops.len();
        for op in &ops {
            if let Err(e) = meta.apply(op) {
                // A rejected record means the log outran the checkpoint in a way
                // the state machine disagrees with. Keep going so the rest of the
                // log is not lost, but say so loudly.
                tracing::error!("wal replay rejected a record: {e}");
            }
        }
        if replayed > 0 {
            tracing::info!("replayed {replayed} wal records");
        }

        let chunks = Arc::new(ChunkStore::new(&state_dir.join("chunks"), backend.clone())?);
        chunks.mark_dirty_if_local(&meta.live_chunks());

        let sync = SyncState { file: wal.sync_handle()?, synced: 0 };

        Ok(Arc::new(Volume {
            core: Mutex::new(Core { wal, meta }),
            sync: Mutex::new(sync),
            appended: AtomicU64::new(0),
            inode_locks: parking_lot::Mutex::new(HashMap::new()),
            chunks,
            name: volume_name(backend_url),
            filesystem_id,
            backend,
            state_dir: state_dir.to_path_buf(),
            owner,
        }))
    }

    pub fn backend_url(&self) -> &str {
        self.backend.url()
    }

    /// What this volume is called: the last meaningful component of its
    /// backing location. Used as the NFS export and SMB share name, so a
    /// machine serving several volumes does not present several things all
    /// called the same thing.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn root(&self) -> Ino {
        ROOT_INO
    }

    /// Append a batch, then wait until it is durable. Every mutation goes
    /// through here, so nothing is ever acknowledged before it could survive a
    /// crash.
    async fn commit(&self, ops: &[Op]) -> Result<()> {
        let seq = {
            let mut core = self.core.lock().await;
            core.append_and_apply(ops)?;
            // Numbered under the same lock as the append, so batch order and
            // file order cannot disagree.
            self.appended.fetch_add(1, Ordering::AcqRel) + 1
        };
        self.sync_through(seq).await
    }

    /// Ensure batch `seq` is on disk.
    ///
    /// If another task already synced past this batch, there is nothing to do.
    /// Otherwise this task performs the sync — and by reading the append
    /// counter before starting, it also covers every batch that landed while it
    /// was waiting for the lock, which is the whole point.
    async fn sync_through(&self, seq: u64) -> Result<()> {
        let mut sync = self.sync.lock().await;
        if sync.synced >= seq {
            return Ok(());
        }
        // Read before syncing: a batch appended after this point may not be
        // covered, so it must not be claimed as durable.
        let covered = self.appended.load(Ordering::Acquire);
        let file = Arc::clone(&sync.file);
        // fsync blocks for milliseconds; keeping it off the runtime's worker
        // threads is what lets other writers make progress meanwhile.
        tokio::task::spawn_blocking(move || file.sync_data())
            .await
            .map_err(|e| FsError::Backend(format!("sync task failed: {e}")))??;
        sync.synced = sync.synced.max(covered);
        Ok(())
    }

    /// The lock guarding read-modify-write for one inode.
    fn inode_lock(&self, ino: Ino) -> Arc<Mutex<()>> {
        let mut locks = self.inode_locks.lock();
        if locks.len() > 4096 {
            // Drop entries nobody is holding, so a long-lived server does not
            // accumulate one lock per file it has ever touched.
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(locks.entry(ino).or_default())
    }

    pub async fn stats(&self) -> Stats {
        let core = self.core.lock().await;
        Stats {
            inodes: core.meta.len(),
            wal_bytes: core.wal.bytes(),
            dirty_chunks: self.chunks.dirty_chunks().len(),
        }
    }

    // ---- namespace ----

    pub async fn lookup(&self, parent: Ino, name: &[u8]) -> Result<Ino> {
        self.core.lock().await.meta.lookup(parent, name)
    }

    /// The parent directory of an inode. The root is its own parent.
    pub async fn parent(&self, ino: Ino) -> Result<Ino> {
        Ok(self.core.lock().await.meta.get(ino)?.parent)
    }

    pub async fn getattr(&self, ino: Ino) -> Result<Attr> {
        Ok(self.core.lock().await.meta.get(ino)?.attr())
    }

    pub async fn setattr(&self, ino: Ino, set: SetAttr) -> Result<Attr> {
        // Truncation rewrites the chunk straddling the new end of file, so it
        // races with writes to the same inode unless it takes the same lock.
        let lock = self.inode_lock(ino);
        let _guard = lock.lock().await;

        let core = self.core.lock().await;
        let inode = core.meta.get(ino)?;
        if set.size.is_some() && inode.kind() == Kind::Dir {
            return Err(FsError::IsDir);
        }
        let now = Timespec::now();
        let mut ops = vec![Op::SetAttr {
            ino,
            mode: set.mode,
            uid: set.uid,
            gid: set.gid,
            size: set.size,
            atime: set.atime,
            mtime: set.mtime,
            time: now,
        }];

        // Truncating to a point inside a chunk must actually drop the bytes
        // after it. Keeping them would be invisible until the file was extended
        // again, at which point stale data would reappear where POSIX promises
        // zeroes. `SetAttr` keeps the straddling chunk; this replaces it with a
        // shortened one.
        if let Some(new_size) = set.size
            && new_size < inode.size {
                let boundary = (new_size / CHUNK_SIZE) * CHUNK_SIZE;
                let keep = (new_size - boundary) as usize;
                if keep > 0
                    && let Body::File { chunks } = &inode.body
                        && let Some(&id) = chunks.get(&boundary) {
                            let data = self.chunks.get(id).await?;
                            let trimmed =
                                self.chunks.put(&data[..keep.min(data.len())]).await?;
                            ops.push(Op::SetChunk {
                                ino,
                                offset: boundary,
                                chunk: Some(trimmed),
                                size: new_size,
                                time: now,
                            });
                        }
            }

        drop(core);
        self.commit(&ops).await?;
        self.getattr(ino).await
    }

    pub async fn create(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)> {
        self.make_node(parent, name, Kind::File, mode, None).await
    }

    pub async fn mkdir(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)> {
        self.make_node(parent, name, Kind::Dir, mode, None).await
    }

    pub async fn symlink(&self, parent: Ino, name: &[u8], target: &[u8]) -> Result<(Ino, Attr)> {
        self.make_node(parent, name, Kind::Symlink, 0o777, Some(target.to_vec())).await
    }

    pub async fn readlink(&self, ino: Ino) -> Result<Vec<u8>> {
        match &self.core.lock().await.meta.get(ino)?.body {
            Body::Symlink { target } => Ok(target.clone()),
            _ => Err(FsError::Inval),
        }
    }

    async fn make_node(
        &self,
        parent: Ino,
        name: &[u8],
        kind: Kind,
        mode: u32,
        target: Option<Vec<u8>>,
    ) -> Result<(Ino, Attr)> {
        if name.is_empty() || name.contains(&b'/') || name == b"." || name == b".." {
            return Err(FsError::Inval);
        }
        let mut core = self.core.lock().await;
        if core.meta.get(parent)?.kind() != Kind::Dir {
            return Err(FsError::NotDir);
        }
        if core.meta.lookup(parent, name).is_ok() {
            return Err(FsError::Exists);
        }
        let ino = core.meta.alloc_ino();
        let op = Op::Create {
            ino,
            parent,
            name: name.to_vec(),
            kind,
            mode,
            uid: self.owner.0,
            gid: self.owner.1,
            target,
            time: Timespec::now(),
        };
        drop(core);
        self.commit(&[op]).await?;
        Ok((ino, self.getattr(ino).await?))
    }

    pub async fn remove(&self, parent: Ino, name: &[u8]) -> Result<()> {
        let core = self.core.lock().await;
        let ino = core.meta.lookup(parent, name)?;
        if let Body::Dir { entries } = &core.meta.get(ino)?.body
            && !entries.is_empty() {
                return Err(FsError::NotEmpty);
            }
        drop(core);
        self.commit(&[Op::Remove { parent, name: name.to_vec(), time: Timespec::now() }])
            .await
    }

    pub async fn rename(
        &self,
        from_parent: Ino,
        from_name: &[u8],
        to_parent: Ino,
        to_name: &[u8],
    ) -> Result<()> {
        let core = self.core.lock().await;
        let ino = core.meta.lookup(from_parent, from_name)?;
        if core.meta.get(to_parent)?.kind() != Kind::Dir {
            return Err(FsError::NotDir);
        }
        // Refuse to move a directory inside itself, which would orphan a cycle.
        if core.meta.get(ino)?.kind() == Kind::Dir {
            let mut walk = to_parent;
            loop {
                if walk == ino {
                    return Err(FsError::Inval);
                }
                let parent = core.meta.get(walk)?.parent;
                if parent == walk {
                    break;
                }
                walk = parent;
            }
        }
        if let Ok(existing) = core.meta.lookup(to_parent, to_name)
            && existing != ino
                && let Body::Dir { entries } = &core.meta.get(existing)?.body
                    && !entries.is_empty() {
                        return Err(FsError::NotEmpty);
                    }
        drop(core);
        self.commit(&[Op::Rename {
            from_parent,
            from_name: from_name.to_vec(),
            to_parent,
            to_name: to_name.to_vec(),
            time: Timespec::now(),
        }])
        .await
    }

    /// Directory listing. `start_after` is an inode number: entries are
    /// returned in name order, resuming after the entry with that inode, which
    /// is the cookie model NFS readdir expects.
    pub async fn readdir(
        &self,
        dir: Ino,
        start_after: Ino,
        max_entries: usize,
    ) -> Result<(Vec<(Vec<u8>, Attr)>, bool)> {
        let core = self.core.lock().await;
        let entries = core.meta.entries(dir)?;
        let mut iter = entries.iter().peekable();

        if start_after != 0 {
            let mut found = false;
            for (_, ino) in iter.by_ref() {
                if *ino == start_after {
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(FsError::Inval);
            }
        }

        let mut out = Vec::new();
        while out.len() < max_entries {
            let Some((name, ino)) = iter.next() else { break };
            out.push((name.clone(), core.meta.get(*ino)?.attr()));
        }
        Ok((out, iter.peek().is_none()))
    }

    // ---- file data ----

    pub async fn read(&self, ino: Ino, offset: u64, count: u32) -> Result<(Vec<u8>, bool)> {
        // Collect what to fetch under the lock, then do the I/O without it.
        let (pieces, size) = {
            let core = self.core.lock().await;
            let inode = core.meta.get(ino)?;
            let Body::File { chunks } = &inode.body else {
                return Err(FsError::IsDir);
            };
            let size = inode.size;
            if offset >= size {
                return Ok((Vec::new(), true));
            }
            let want = (count as u64).min(size - offset);
            let pieces: Vec<_> = split_range(offset, want)
                .into_iter()
                .map(|(chunk_off, within, len)| (chunk_off, within, len, chunks.get(&chunk_off).copied()))
                .collect();
            (pieces, size)
        };

        let mut out = Vec::with_capacity(pieces.iter().map(|p| p.2 as usize).sum());
        for (_chunk_off, within, len, id) in pieces {
            match id {
                Some(id) => {
                    let data = self.chunks.get(id).await?;
                    let start = (within as usize).min(data.len());
                    let end = (start + len as usize).min(data.len());
                    out.extend_from_slice(&data[start..end]);
                    // A chunk can be short when the file was extended past it;
                    // the rest of the range is a hole.
                    out.resize(out.len() + (len as usize - (end - start)), 0);
                }
                // Hole: reads as zeroes.
                None => out.resize(out.len() + len as usize, 0),
            }
        }
        let eof = offset + out.len() as u64 >= size;
        Ok((out, eof))
    }

    pub async fn write(&self, ino: Ino, offset: u64, data: &[u8]) -> Result<Attr> {
        if data.is_empty() {
            return self.getattr(ino).await;
        }
        // Serialise read-modify-write for this inode only. The global lock is
        // taken twice below, briefly, and never held across chunk I/O — so a
        // writer on another file, or the next write to this one, can proceed
        // while this one waits on fsync.
        let lock = self.inode_lock(ino);
        let _guard = lock.lock().await;

        // Phase 1: snapshot what this write needs to know.
        let (pieces, old_size, new_size) = {
            let core = self.core.lock().await;
            let inode = core.meta.get(ino)?;
            let Body::File { chunks } = &inode.body else {
                return Err(FsError::IsDir);
            };
            let pieces: Vec<_> = split_range(offset, data.len() as u64)
                .into_iter()
                .map(|(chunk_off, within, len)| {
                    (chunk_off, within, len, chunks.get(&chunk_off).copied())
                })
                .collect();
            let old_size = inode.size;
            (pieces, old_size, old_size.max(offset + data.len() as u64))
        };

        // Phase 2: build the new chunks, holding no global lock.
        let now = Timespec::now();
        let mut ops = Vec::with_capacity(pieces.len());
        let mut consumed = 0usize;
        for (chunk_off, within, len, old) in pieces {
            let piece = &data[consumed..consumed + len as usize];
            consumed += len as usize;

            let full_chunk = within == 0 && len == CHUNK_SIZE;
            let body: Bytes = if full_chunk {
                Bytes::copy_from_slice(piece)
            } else {
                // Rebuild the chunk around the piece being written.
                let base = match old {
                    Some(id) => self.chunks.get(id).await?,
                    None => Bytes::new(),
                };
                let tail_len = (old_size.saturating_sub(chunk_off)).min(CHUNK_SIZE) as usize;
                let mut buf = vec![0u8; base.len().max(tail_len).max((within + len) as usize)];
                buf[..base.len()].copy_from_slice(&base);
                buf[within as usize..(within + len) as usize].copy_from_slice(piece);
                Bytes::from(buf)
            };

            let id = self.chunks.put(&body).await?;
            ops.push(Op::SetChunk {
                ino,
                offset: chunk_off,
                chunk: Some(id),
                size: new_size,
                time: now,
            });
        }

        // Phase 3: log it, and wait for durability.
        self.commit(&ops).await?;
        self.getattr(ino).await
    }

    // ---- durability ----

    /// Push everything up to now into the object store and cut the WAL.
    ///
    /// Order matters: chunks must be durable before the metadata that names
    /// them, and the metadata must be durable before the WAL that produced it
    /// is discarded. Anything else can resurrect a snapshot pointing at chunks
    /// that do not exist.
    pub async fn checkpoint(&self) -> Result<u64> {
        let (snapshot, dirty, sealed) = {
            // Hold the sync lock across the rotation: it retires the handle a
            // concurrent sync would otherwise be about to use, and syncing the
            // old segment must not be credited to records already written to
            // the new one.
            let mut sync = self.sync.lock().await;
            let mut core = self.core.lock().await;
            let snapshot = core.meta.clone();
            let dirty = self.chunks.dirty_chunks();
            // `rotate` syncs the segment it seals, so everything appended so
            // far is durable once it returns.
            let sealed = core.wal.rotate()?;
            sync.file = core.wal.sync_handle()?;
            sync.synced = self.appended.load(Ordering::Acquire);
            (snapshot, dirty, sealed)
        };

        let uploaded = self.chunks.upload(&dirty).await?;

        let epoch = Timespec::now().secs;
        let key = format!("meta/snapshot-{epoch:020}.bin");
        self.backend.put(&key, Bytes::from(postcard::to_stdvec(&snapshot)?)).await?;
        self.backend.put(SNAPSHOT_POINTER, Bytes::from(key.into_bytes())).await?;

        // Only now is it safe to forget the log.
        self.core.lock().await.wal.discard_through(sealed)?;

        tracing::info!("checkpoint: {} inodes, {uploaded} chunks uploaded", snapshot.len());
        Ok(epoch)
    }

    /// Background durability loop: checkpoint on a timer, or sooner if the WAL
    /// has grown past its threshold.
    pub fn spawn_flusher(self: &Arc<Self>, interval: std::time::Duration) -> tokio::task::JoinHandle<()> {
        let volume = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let stats = volume.stats().await;
                if stats.wal_bytes == 0 && stats.dirty_chunks == 0 {
                    continue;
                }
                if let Err(e) = volume.checkpoint().await {
                    tracing::error!("checkpoint failed: {e}");
                }
            }
        })
    }

    /// Checkpoint early if the WAL has outgrown its threshold. Cheap to call.
    pub async fn maybe_checkpoint(&self) -> Result<()> {
        if self.core.lock().await.wal.bytes() >= CHECKPOINT_BYTES {
            self.checkpoint().await?;
        }
        Ok(())
    }
}

/// Derive a volume name from a backing location.
///
/// `s3://bucket/projects/photos` is "photos", `s3://bucket` is "bucket", and a
/// local path is its final directory. Anything that would not survive as a
/// share name is replaced, since both NFS exports and SMB shares appear in
/// paths clients construct.
pub fn volume_name(url: &str) -> String {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let cleaned: String = without_scheme
        .trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("lfs")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();

    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "lfs".to_string()
    } else {
        trimmed
    }
}

/// Deterministically turn a canonical backend identity into a nonzero NFS
/// filesystem id. Tokens and other credentials must never be part of the
/// input; callers use only display/backend URLs and resolved remote ids.
pub(crate) fn stable_filesystem_id(identity: &str) -> u64 {
    let digest = blake3::hash(identity.as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest.as_bytes()[..8]);
    u64::from_le_bytes(bytes).max(1)
}

#[cfg(unix)]
pub(crate) fn owner_of(path: &Path) -> (u32, u32) {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).map(|m| (m.uid(), m.gid())).unwrap_or((0, 0))
}

#[cfg(not(unix))]
pub(crate) fn owner_of(_path: &Path) -> (u32, u32) {
    (0, 0)
}

async fn load_snapshot(backend: &Backend) -> Result<Option<MetaStore>> {
    let pointer = match backend.get(SNAPSHOT_POINTER).await {
        Ok(b) => b,
        Err(FsError::NotFound) => return Ok(None),
        Err(e) => return Err(e),
    };
    let key = String::from_utf8_lossy(&pointer).trim().to_string();
    let body = backend.get(&key).await?;
    Ok(Some(postcard::from_bytes::<MetaStore>(&body)?))
}

pub use crate::storage::chunk::CHUNK_SIZE as CHUNK_BYTES;

#[async_trait::async_trait]
impl FileSystem for Volume {
    fn name(&self) -> &str {
        Volume::name(self)
    }

    fn location(&self) -> &str {
        self.backend_url()
    }

    fn filesystem_id(&self) -> u64 {
        self.filesystem_id
    }

    fn root(&self) -> Ino {
        Volume::root(self)
    }

    async fn lookup(&self, parent: Ino, name: &[u8]) -> Result<Ino> {
        Volume::lookup(self, parent, name).await
    }

    async fn getattr(&self, ino: Ino) -> Result<Attr> {
        Volume::getattr(self, ino).await
    }

    async fn parent(&self, ino: Ino) -> Result<Ino> {
        Volume::parent(self, ino).await
    }

    async fn readdir(
        &self,
        dir: Ino,
        start_after: Ino,
        max_entries: usize,
    ) -> Result<(Vec<(Vec<u8>, Attr)>, bool)> {
        Volume::readdir(self, dir, start_after, max_entries).await
    }

    async fn read(&self, ino: Ino, offset: u64, count: u32) -> Result<(Vec<u8>, bool)> {
        Volume::read(self, ino, offset, count).await
    }

    async fn readlink(&self, ino: Ino) -> Result<Vec<u8>> {
        Volume::readlink(self, ino).await
    }

    async fn setattr(&self, ino: Ino, set: SetAttr) -> Result<Attr> {
        Volume::setattr(self, ino, set).await
    }

    async fn write(&self, ino: Ino, offset: u64, data: &[u8]) -> Result<Attr> {
        Volume::write(self, ino, offset, data).await
    }

    async fn create(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)> {
        Volume::create(self, parent, name, mode).await
    }

    async fn mkdir(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)> {
        Volume::mkdir(self, parent, name, mode).await
    }

    async fn symlink(&self, parent: Ino, name: &[u8], target: &[u8]) -> Result<(Ino, Attr)> {
        Volume::symlink(self, parent, name, target).await
    }

    async fn remove(&self, parent: Ino, name: &[u8]) -> Result<()> {
        Volume::remove(self, parent, name).await
    }

    async fn rename(
        &self,
        from_parent: Ino,
        from_name: &[u8],
        to_parent: Ino,
        to_name: &[u8],
    ) -> Result<()> {
        Volume::rename(self, from_parent, from_name, to_parent, to_name).await
    }

    async fn maybe_checkpoint(&self) -> Result<()> {
        Volume::maybe_checkpoint(self).await
    }
}

#[cfg(test)]
mod tests {
    use super::{stable_filesystem_id, volume_name};

    #[test]
    fn names_come_from_the_backing_location() {
        assert_eq!(volume_name("s3://acme-data/projects/photos"), "photos");
        assert_eq!(volume_name("s3://acme-data/projects/photos/"), "photos");
        assert_eq!(volume_name("s3://acme-data"), "acme-data");
        assert_eq!(volume_name("file:///Users/me/volumes/scratch"), "scratch");
        assert_eq!(volume_name("/srv/lfs/archive"), "archive");
    }

    #[test]
    fn names_are_safe_to_put_in_a_path() {
        // Both NFS exports and SMB shares end up inside paths the client builds.
        assert_eq!(volume_name("s3://bucket/my volume"), "my-volume");
        assert_eq!(volume_name("s3://bucket/a\\b"), "a-b");
        assert_eq!(volume_name("memory://"), "lfs");
        assert_eq!(volume_name("s3://bucket/---"), "lfs");
    }

    #[test]
    fn filesystem_ids_are_stable_nonzero_and_backend_specific() {
        let a = stable_filesystem_id("s3://bucket/a");
        assert_ne!(a, 0);
        assert_eq!(a, stable_filesystem_id("s3://bucket/a"));
        assert_ne!(a, stable_filesystem_id("s3://bucket/b"));
    }
}

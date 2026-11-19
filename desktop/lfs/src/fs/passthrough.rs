//! Present objects already in a bucket as a filesystem.
//!
//! This is the opposite arrangement to [`Volume`](super::Volume). A volume
//! stores a filesystem *in* an object store, in its own chunked format; a
//! passthrough stores nothing and shows what is already there, mapping one
//! object to one file and `/` in a key to a directory boundary.
//!
//! S3 has no directories. A "directory" here is a common prefix — the set of
//! keys sharing a prefix up to the next `/` — which is what
//! [`Backend::list_dir`] returns.
//!
//! Writes are supported, but they work differently to a
//! [`Volume`](super::Volume) and the difference is worth stating plainly.
//!
//! An object is written whole. There is no way to change one byte of it in
//! place, so a write is buffered into a local scratch file and the whole object
//! is uploaded once the file has been idle for a moment. Two consequences:
//!
//! * A write is acknowledged when it is durable *locally*, not when it has
//!   reached the object store. A volume's WAL makes that gap recoverable; here
//!   there is no log, so a crash between the two loses the write. [`sync`] is
//!   what closes the window, and the server calls it before exiting.
//! * Every write to a file costs one upload of the entire file. Appending to a
//!   large object repeatedly is expensive, which is inherent to the storage and
//!   not something this layer can hide.
//!
//! S3 has no directories, so `mkdir` writes a zero-byte object ending in `/` —
//! the marker every S3 tool uses — and a directory that holds objects needs no
//! marker at all.
//!
//! [`sync`]: FileSystem::sync

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use bytes::Bytes;

use crate::error::{FsError, Result};
use crate::storage::backend::Backend;
use crate::storage::meta::{Attr, Ino, Kind, SetAttr, Timespec, ROOT_INO};

use super::api::FileSystem;

/// How long a directory listing is trusted before being fetched again.
///
/// Listings cost a round trip to the object store, and clients list far more
/// often than the bucket changes; this is the compromise between a responsive
/// mount and showing stale contents.
const LISTING_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// How long a file must go unwritten before its object is uploaded.
///
/// Every upload sends the whole object, so uploading per write would make
/// writing a large file quadratic. Waiting for a pause coalesces a client's
/// stream of writes into one upload, at the cost of leaving the write buffered
/// locally for that long.
const WRITE_IDLE: std::time::Duration = std::time::Duration::from_millis(1500);

/// The marker object a directory is represented by when it holds nothing else.
const DIR_MARKER: &str = "/";
const IDENTITY_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Node {
    /// Key of the object, or prefix of the directory, relative to the volume
    /// root. The root itself is the empty string.
    key: String,
    kind: Kind,
    size: u64,
    modified: u64,
}

struct Listing {
    /// Child name -> inode.
    children: Vec<(Vec<u8>, Ino)>,
    fetched: std::time::Instant,
}

/// A file being written: its bytes live in a local scratch file until the
/// object is uploaded.
struct Pending {
    key: String,
    scratch: PathBuf,
    size: u64,
    last_write: std::time::Instant,
}

#[derive(Debug, Serialize, Deserialize)]
struct DurableIdentities {
    version: u32,
    scope: String,
    next_ino: Ino,
    nodes: HashMap<String, DurableNode>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DurableNode {
    ino: Ino,
    kind: Kind,
    size: u64,
    modified: u64,
}

pub struct Passthrough {
    backend: Backend,
    name: String,
    location: String,
    filesystem_id: u64,
    writable: bool,
    /// Owner reported for every file. An object store records none, and
    /// reporting root would make a writable mount look untouchable to the user
    /// who mounted it.
    owner: (u32, u32),
    /// Where scratch files for buffered writes live.
    scratch_dir: PathBuf,
    identity_path: PathBuf,
    inner: Mutex<Inner>,
    pending: tokio::sync::Mutex<HashMap<Ino, Pending>>,
}

struct Inner {
    nodes: HashMap<Ino, Node>,
    /// Key -> inode, so a path seen twice keeps one identity. Clients cache
    /// inode numbers and will misbehave if the same file changes number.
    by_key: HashMap<String, Ino>,
    listings: HashMap<Ino, Listing>,
    next_ino: Ino,
}

impl Passthrough {
    pub async fn open(location: &str, scratch_dir: &Path, writable: bool) -> Result<Arc<Passthrough>> {
        let backend = Backend::open(location)?;
        let name = super::volume_name(location);
        let filesystem_id = super::stable_filesystem_id(backend.url());
        std::fs::create_dir_all(scratch_dir)?;
        let identity_path = scratch_dir.join("identities.json");

        let root = Node {
            key: String::new(),
            kind: Kind::Dir,
            size: 0,
            modified: Timespec::now().secs,
        };
        let mut nodes = HashMap::new();
        nodes.insert(ROOT_INO, root);
        let mut by_key = HashMap::new();
        by_key.insert(String::new(), ROOT_INO);

        let fs = Arc::new(Passthrough {
            location: backend.url().to_string(),
            filesystem_id,
            backend,
            name,
            writable,
            owner: super::owner_of(scratch_dir),
            scratch_dir: scratch_dir.to_path_buf(),
            identity_path,
            pending: tokio::sync::Mutex::new(HashMap::new()),
            inner: Mutex::new(Inner {
                nodes,
                by_key,
                listings: HashMap::new(),
                next_ino: ROOT_INO + 1,
            }),
        });

        fs.load_identities()?;
        // Fail loudly at mount time rather than on the first `ls`.
        fs.list(ROOT_INO).await?;
        Ok(fs)
    }

    fn node(&self, ino: Ino) -> Result<Node> {
        self.inner.lock().nodes.get(&ino).cloned().ok_or(FsError::NotFound)
    }

    fn attr_of(&self, node: &Node, ino: Ino) -> Attr {
        let time = Timespec { secs: node.modified, nanos: 0 };
        // The mode has to match what the filesystem will actually allow, in
        // both directions: a writable mount reported as `r--` looks locked and
        // makes tools that preserve attributes fail, and a read-only one
        // reported as `rw-` invites a write that is then refused.
        let mode = match (node.kind, self.writable) {
            (Kind::Dir, true) => 0o755,
            (Kind::Dir, false) => 0o555,
            (_, true) => 0o644,
            (_, false) => 0o444,
        };
        Attr {
            ino,
            kind: node.kind,
            mode,
            nlink: 1,
            uid: self.owner.0,
            gid: self.owner.1,
            size: node.size,
            atime: time,
            mtime: time,
            ctime: time,
        }
    }

    fn identity_scope(&self) -> String {
        format!("browse:{}", self.location)
    }

    fn load_identities(&self) -> Result<()> {
        let bytes = match std::fs::read(&self.identity_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let saved: DurableIdentities = serde_json::from_slice(&bytes)
            .map_err(|e| FsError::Corrupt(format!("{}: {e}", self.identity_path.display())))?;
        let scope = self.identity_scope();
        if saved.version != IDENTITY_VERSION || saved.scope != scope {
            return Err(FsError::Corrupt(format!(
                "{} belongs to an incompatible browse volume",
                self.identity_path.display()
            )));
        }
        if saved.nodes.values().any(|node| node.ino <= ROOT_INO) {
            return Err(FsError::Corrupt(format!(
                "{} contains a reserved inode",
                self.identity_path.display()
            )));
        }
        let minimum_next = saved
            .nodes
            .values()
            .map(|node| node.ino)
            .max()
            .unwrap_or(ROOT_INO)
            .saturating_add(1);
        if saved.next_ino < minimum_next {
            return Err(FsError::Corrupt(format!(
                "{} would reuse an allocated inode",
                self.identity_path.display()
            )));
        }

        let mut inner = self.inner.lock();
        inner.next_ino = saved.next_ino.max(ROOT_INO + 1);
        for (key, saved) in saved.nodes {
            inner.by_key.insert(key.clone(), saved.ino);
            inner.nodes.insert(
                saved.ino,
                Node {
                    key,
                    kind: saved.kind,
                    size: saved.size,
                    modified: saved.modified,
                },
            );
        }
        Ok(())
    }

    fn save_identities(&self, inner: &Inner) -> Result<()> {
        let nodes = inner
            .by_key
            .iter()
            .filter_map(|(key, ino)| {
                let node = inner.nodes.get(ino)?;
                (!key.is_empty()).then(|| {
                    (
                        key.clone(),
                        DurableNode {
                            ino: *ino,
                            kind: node.kind,
                            size: node.size,
                            modified: node.modified,
                        },
                    )
                })
            })
            .collect();
        let saved = DurableIdentities {
            version: IDENTITY_VERSION,
            scope: self.identity_scope(),
            next_ino: inner.next_ino,
            nodes,
        };
        let bytes = serde_json::to_vec_pretty(&saved)
            .map_err(|e| FsError::Corrupt(format!("serialize identities: {e}")))?;
        let tmp = self
            .identity_path
            .with_extension(format!("json.tmp.{}", std::process::id()));
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.identity_path)?;
        Ok(())
    }

    /// Intern a child node, reusing the inode if this key has been seen.
    fn intern(
        inner: &mut Inner,
        key: String,
        kind: Kind,
        size: u64,
        modified: u64,
    ) -> (Ino, bool) {
        if let Some(&ino) = inner.by_key.get(&key) {
            let node = Node { key, kind, size, modified };
            let changed = inner.nodes.get(&ino) != Some(&node);
            inner.nodes.insert(ino, node);
            return (ino, changed);
        }
        let ino = inner.next_ino;
        inner.next_ino += 1;
        inner.by_key.insert(key.clone(), ino);
        inner.nodes.insert(ino, Node { key, kind, size, modified });
        (ino, true)
    }

    /// Children of a directory, from cache when fresh.
    async fn list(&self, dir: Ino) -> Result<Vec<(Vec<u8>, Ino)>> {
        let node = self.node(dir)?;
        if node.kind != Kind::Dir {
            return Err(FsError::NotDir);
        }
        {
            let inner = self.inner.lock();
            if let Some(listing) = inner.listings.get(&dir)
                .filter(|l| l.fetched.elapsed() < LISTING_TTL)
            {
                return Ok(listing.children.clone());
            }
        }

        let (dirs, objects) = self.backend.list_dir(&node.key).await?;

        // Files written but not yet uploaded exist nowhere else. Rebuilding a
        // listing from the object store alone would drop a file the client has
        // just created, making it vanish between `create` and the flush.
        let buffered: Vec<(String, u64)> = {
            let pending = self.pending.lock().await;
            pending
                .values()
                .filter_map(|p| {
                    let (parent, name) = match p.key.rsplit_once('/') {
                        Some((parent, name)) => (parent, name),
                        None => ("", p.key.as_str()),
                    };
                    (parent == node.key).then(|| (name.to_string(), p.size))
                })
                .collect()
        };

        let mut inner = self.inner.lock();
        let mut children: Vec<(Vec<u8>, Ino)> = Vec::with_capacity(dirs.len() + objects.len());
        let mut live_keys = HashSet::new();
        let mut identities_changed = false;
        let now = Timespec::now().secs;
        for name in dirs {
            let name = name.trim_end_matches('/').to_string();
            if name.is_empty() {
                continue;
            }
            let key = join(&node.key, &name);
            live_keys.insert(key.clone());
            let (ino, changed) = Self::intern(&mut inner, key, Kind::Dir, 0, now);
            identities_changed |= changed;
            children.push((name.into_bytes(), ino));
        }
        for object in objects {
            let key = join(&node.key, &object.name);
            live_keys.insert(key.clone());
            let (ino, changed) =
                Self::intern(&mut inner, key, Kind::File, object.size, object.modified);
            identities_changed |= changed;
            children.push((object.name.into_bytes(), ino));
        }
        for (name, size) in buffered {
            if children.iter().any(|(existing, _)| existing == name.as_bytes()) {
                continue;
            }
            let key = join(&node.key, &name);
            live_keys.insert(key.clone());
            let (ino, changed) = Self::intern(&mut inner, key, Kind::File, size, now);
            identities_changed |= changed;
            children.push((name.into_bytes(), ino));
        }
        children.sort_by(|a, b| a.0.cmp(&b.0));

        let stale: Vec<String> = inner
            .by_key
            .keys()
            .filter(|key| {
                !key.is_empty() && parent_key(key) == node.key && !live_keys.contains(*key)
            })
            .cloned()
            .collect();
        for key in stale {
            if let Some(ino) = inner.by_key.remove(&key) {
                inner.nodes.remove(&ino);
                identities_changed = true;
            }
        }
        if identities_changed {
            self.save_identities(&inner)?;
        }

        inner.listings.insert(
            dir,
            Listing { children: children.clone(), fetched: std::time::Instant::now() },
        );
        Ok(children)
    }

    // ---- writing ----

    fn require_writable(&self) -> Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(FsError::ReadOnly)
        }
    }

    /// The scratch file backing an inode's buffered content, materialising it
    /// from the object store on first write so a partial write does not lose
    /// the rest of the object.
    async fn begin_write(&self, ino: Ino, node: &Node) -> Result<PathBuf> {
        let mut pending = self.pending.lock().await;
        if let Some(entry) = pending.get(&ino) {
            return Ok(entry.scratch.clone());
        }

        let scratch = self.scratch_dir.join(format!("{ino}.part"));
        let existing = if node.size > 0 {
            self.backend.get(&node.key).await.unwrap_or_default()
        } else {
            Bytes::new()
        };
        std::fs::write(&scratch, &existing)?;

        pending.insert(
            ino,
            Pending {
                key: node.key.clone(),
                scratch: scratch.clone(),
                size: existing.len() as u64,
                last_write: std::time::Instant::now(),
            },
        );
        Ok(scratch)
    }

    /// Upload every buffered file that has been idle long enough, or all of
    /// them when `force`.
    async fn flush_pending(&self, force: bool) -> Result<()> {
        let ready: Vec<Ino> = {
            let pending = self.pending.lock().await;
            pending
                .iter()
                .filter(|(_, p)| force || p.last_write.elapsed() >= WRITE_IDLE)
                .map(|(ino, _)| *ino)
                .collect()
        };

        let mut uploaded = false;
        for ino in ready {
            // Re-check under the lock: a write may have landed since.
            let entry = {
                let mut pending = self.pending.lock().await;
                match pending.get(&ino) {
                    Some(p) if force || p.last_write.elapsed() >= WRITE_IDLE => {
                        pending.remove(&ino)
                    }
                    _ => None,
                }
            };
            let Some(entry) = entry else { continue };

            let data = std::fs::read(&entry.scratch)?;
            match self.backend.put(&entry.key, Bytes::from(data)).await {
                Ok(()) => {
                    let _ = std::fs::remove_file(&entry.scratch);
                    tracing::debug!("uploaded {} ({} bytes)", entry.key, entry.size);
                    uploaded = true;
                }
                Err(e) => {
                    // Put it back rather than dropping the user's bytes; the
                    // next flush will try again.
                    tracing::error!("upload of {} failed, will retry: {e}", entry.key);
                    self.pending.lock().await.insert(ino, entry);
                    return Err(e);
                }
            }
        }
        if uploaded {
            let inner = self.inner.lock();
            self.save_identities(&inner)?;
        }
        // A new or resized object changes what a listing should say.
        self.invalidate_listings();
        Ok(())
    }

    fn invalidate_listings(&self) {
        self.inner.lock().listings.clear();
    }

    /// Register a node that does not exist in the object store yet.
    fn insert_child(&self, parent_key: &str, name: &str, kind: Kind) -> Result<Ino> {
        let key = join(parent_key, name);
        let mut inner = self.inner.lock();
        let (ino, changed) = Self::intern(&mut inner, key, kind, 0, Timespec::now().secs);
        if changed {
            self.save_identities(&inner)?;
        }
        Ok(ino)
    }

}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", prefix.trim_end_matches('/'), name)
    }
}

fn parent_key(key: &str) -> &str {
    key.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")
}

#[async_trait]
impl FileSystem for Passthrough {
    fn name(&self) -> &str {
        &self.name
    }

    fn location(&self) -> &str {
        &self.location
    }

    fn filesystem_id(&self) -> u64 {
        self.filesystem_id
    }

    fn root(&self) -> Ino {
        ROOT_INO
    }

    fn writable(&self) -> bool {
        self.writable
    }

    async fn lookup(&self, parent: Ino, name: &[u8]) -> Result<Ino> {
        let children = self.list(parent).await?;
        if let Some((_, ino)) = children.iter().find(|(n, _)| n == name) {
            return Ok(*ino);
        }

        // Not in the listing: it may be an object created since, so ask
        // directly rather than making the client wait for the cache to expire.
        let parent_node = self.node(parent)?;
        let key = join(&parent_node.key, &String::from_utf8_lossy(name));
        let entry = self.backend.head(&key).await?;
        let mut inner = self.inner.lock();
        let (ino, changed) = Self::intern(&mut inner, key, Kind::File, entry.size, entry.modified);
        if changed {
            self.save_identities(&inner)?;
        }
        Ok(ino)
    }

    async fn getattr(&self, ino: Ino) -> Result<Attr> {
        Ok(self.attr_of(&self.node(ino)?, ino))
    }

    async fn parent(&self, ino: Ino) -> Result<Ino> {
        let node = self.node(ino)?;
        let parent_key = match node.key.rfind('/') {
            Some(at) => node.key[..at].to_string(),
            None => String::new(),
        };
        Ok(self.inner.lock().by_key.get(&parent_key).copied().unwrap_or(ROOT_INO))
    }

    async fn readdir(
        &self,
        dir: Ino,
        start_after: Ino,
        max_entries: usize,
    ) -> Result<(Vec<(Vec<u8>, Attr)>, bool)> {
        let children = self.list(dir).await?;
        let mut iter = children.iter().peekable();

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
            out.push((name.clone(), self.attr_of(&self.node(*ino)?, *ino)));
        }
        Ok((out, iter.peek().is_none()))
    }

    async fn read(&self, ino: Ino, offset: u64, count: u32) -> Result<(Vec<u8>, bool)> {
        let node = self.node(ino)?;
        if node.kind == Kind::Dir {
            return Err(FsError::IsDir);
        }

        // A file with unflushed writes reads from the scratch file, or a client
        // would read back what it has just written and see the old object.
        if let Some(entry) = self.pending.lock().await.get(&ino) {
            let data = std::fs::read(&entry.scratch)?;
            let start = (offset as usize).min(data.len());
            let end = (start + count as usize).min(data.len());
            return Ok((data[start..end].to_vec(), end >= data.len()));
        }

        if offset >= node.size {
            return Ok((Vec::new(), true));
        }
        let want = (count as u64).min(node.size - offset);
        if want == 0 {
            return Ok((Vec::new(), false));
        }
        let data = self.backend.get_range(&node.key, offset, want).await?;
        let eof = offset + data.len() as u64 >= node.size;
        Ok((data.to_vec(), eof))
    }

    async fn readlink(&self, _ino: Ino) -> Result<Vec<u8>> {
        Err(FsError::Inval)
    }

    async fn setattr(&self, ino: Ino, set: SetAttr) -> Result<Attr> {
        self.require_writable()?;
        // Only size is actionable: an object store records no mode, owner, or
        // access time, so accepting those and dropping them would be a lie.
        // Reporting success for them anyway keeps `cp` and editors working,
        // which set them as a matter of course.
        let Some(size) = set.size else {
            return self.getattr(ino).await;
        };

        let node = self.node(ino)?;
        if node.kind == Kind::Dir {
            return Err(FsError::IsDir);
        }
        let scratch = self.begin_write(ino, &node).await?;

        let file = std::fs::OpenOptions::new().write(true).open(&scratch)?;
        file.set_len(size)?;
        file.sync_all()?;

        let mut pending = self.pending.lock().await;
        if let Some(entry) = pending.get_mut(&ino) {
            entry.size = size;
            entry.last_write = std::time::Instant::now();
        }
        drop(pending);

        self.inner.lock().nodes.entry(ino).and_modify(|n| n.size = size);
        self.getattr(ino).await
    }

    async fn write(&self, ino: Ino, offset: u64, data: &[u8]) -> Result<Attr> {
        self.require_writable()?;
        let node = self.node(ino)?;
        if node.kind == Kind::Dir {
            return Err(FsError::IsDir);
        }
        let scratch = self.begin_write(ino, &node).await?;

        {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = std::fs::OpenOptions::new().write(true).open(&scratch)?;
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(data)?;
            // Durable locally before the write is acknowledged. The object
            // store catches up on the next flush.
            file.sync_data()?;
        }

        let size = std::fs::metadata(&scratch)?.len();
        let mut pending = self.pending.lock().await;
        if let Some(entry) = pending.get_mut(&ino) {
            entry.size = size;
            entry.last_write = std::time::Instant::now();
        }
        drop(pending);

        self.inner.lock().nodes.entry(ino).and_modify(|n| {
            n.size = size;
            n.modified = Timespec::now().secs;
        });
        self.getattr(ino).await
    }

    async fn create(&self, parent: Ino, name: &[u8], _mode: u32) -> Result<(Ino, Attr)> {
        self.require_writable()?;
        let parent_node = self.node(parent)?;
        if parent_node.kind != Kind::Dir {
            return Err(FsError::NotDir);
        }
        let name = String::from_utf8_lossy(name).to_string();
        if self.lookup(parent, name.as_bytes()).await.is_ok() {
            return Err(FsError::Exists);
        }

        // The object is written by the first flush; until then the file exists
        // only here, which is what lets a client create and then write to it.
        let ino = self.insert_child(&parent_node.key, &name, Kind::File)?;
        let node = self.node(ino)?;
        self.begin_write(ino, &node).await?;
        self.invalidate_listings();
        Ok((ino, self.attr_of(&node, ino)))
    }

    async fn mkdir(&self, parent: Ino, name: &[u8], _mode: u32) -> Result<(Ino, Attr)> {
        self.require_writable()?;
        let parent_node = self.node(parent)?;
        if parent_node.kind != Kind::Dir {
            return Err(FsError::NotDir);
        }
        let name = String::from_utf8_lossy(name).to_string();
        let key = join(&parent_node.key, &name);

        // S3 has no directories. A zero-byte object ending in `/` is the marker
        // every S3 tool understands, and is what makes an empty directory
        // survive a remount.
        self.backend
            .put(&format!("{key}{DIR_MARKER}"), Bytes::new())
            .await?;

        let ino = self.insert_child(&parent_node.key, &name, Kind::Dir)?;
        self.invalidate_listings();
        Ok((ino, self.attr_of(&self.node(ino)?, ino)))
    }

    async fn symlink(&self, _parent: Ino, _name: &[u8], _target: &[u8]) -> Result<(Ino, Attr)> {
        // An object store has no symlink, and inventing an encoding for one
        // would make files that only this program can read.
        Err(FsError::Inval)
    }

    async fn remove(&self, parent: Ino, name: &[u8]) -> Result<()> {
        self.require_writable()?;
        let ino = self.lookup(parent, name).await?;
        let node = self.node(ino)?;

        if node.kind == Kind::Dir {
            let (dirs, objects) = self.backend.list_dir(&node.key).await?;
            if !dirs.is_empty() || !objects.is_empty() {
                return Err(FsError::NotEmpty);
            }
            self.backend
                .delete(&format!("{}{DIR_MARKER}", node.key))
                .await?;
        } else {
            // Drop any buffered bytes first, or a flush would recreate the
            // object after the delete.
            if let Some(entry) = self.pending.lock().await.remove(&ino) {
                let _ = std::fs::remove_file(&entry.scratch);
            }
            self.backend.delete(&node.key).await?;
        }

        let mut inner = self.inner.lock();
        inner.nodes.remove(&ino);
        inner.by_key.remove(&node.key);
        inner.listings.clear();
        self.save_identities(&inner)?;
        Ok(())
    }

    async fn rename(
        &self,
        from_parent: Ino,
        from_name: &[u8],
        to_parent: Ino,
        to_name: &[u8],
    ) -> Result<()> {
        self.require_writable()?;
        let ino = self.lookup(from_parent, from_name).await?;
        let node = self.node(ino)?;
        if node.kind == Kind::Dir {
            // Renaming a prefix means copying every key beneath it. Refusing is
            // better than a half-moved tree with no way to roll back.
            return Err(FsError::Inval);
        }

        let to_node = self.node(to_parent)?;
        let target = join(&to_node.key, &String::from_utf8_lossy(to_name));

        // Anything still buffered has to land before the copy, or the copy
        // would move the pre-write object.
        self.flush_pending(true).await?;

        // POSIX rename replaces the target. Copying over it does that in the
        // object store, but any inode already standing for the target has to go
        // too, or a stale entry keeps pointing at a key that now holds the
        // source's bytes.
        let replaced = self.lookup(to_parent, to_name).await.ok();

        self.backend.copy(&node.key, &target).await?;
        self.backend.delete(&node.key).await?;

        let mut inner = self.inner.lock();
        if let Some(old) = replaced.filter(|old| *old != ino) {
            inner.nodes.remove(&old);
            inner.by_key.remove(&target);
        }
        inner.by_key.remove(&node.key);
        if let Some(n) = inner.nodes.get_mut(&ino) {
            n.key = target.clone();
        }
        inner.by_key.insert(target, ino);
        inner.listings.clear();
        self.save_identities(&inner)?;
        Ok(())
    }

    async fn sync(&self) -> Result<()> {
        self.flush_pending(true).await
    }

    async fn maybe_checkpoint(&self) -> Result<()> {
        // Called after every write. Only uploads what has gone quiet, so a
        // stream of writes coalesces into one upload rather than one each.
        self.flush_pending(false).await
    }
}

#[cfg(test)]
mod tests {
    use super::join;

    #[test]
    fn keys_join_without_doubling_separators() {
        assert_eq!(join("", "a.txt"), "a.txt");
        assert_eq!(join("docs", "a.txt"), "docs/a.txt");
        assert_eq!(join("docs/", "a.txt"), "docs/a.txt");
    }
}

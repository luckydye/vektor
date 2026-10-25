//! Metadata: inodes, the namespace, and the operation log's state machine.
//!
//! `Op` is the only way state changes. Both the live write path and WAL replay
//! call `MetaStore::apply`, so recovery is by construction identical to normal
//! operation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{FsError, Result};
use crate::storage::chunk::ChunkId;

pub type Ino = u64;
pub const ROOT_INO: Ino = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Timespec {
    pub secs: u64,
    pub nanos: u32,
}

impl Timespec {
    pub fn now() -> Timespec {
        let d = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        Timespec { secs: d.as_secs(), nanos: d.subsec_nanos() }
    }
}

/// What a caller sees. No storage details leak out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attr {
    pub ino: Ino,
    pub kind: Kind,
    pub mode: u32,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub atime: Timespec,
    pub mtime: Timespec,
    pub ctime: Timespec,
}

/// Partial attribute update. `None` means "leave alone".
#[derive(Debug, Clone, Copy, Default)]
pub struct SetAttr {
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub size: Option<u64>,
    pub atime: Option<Timespec>,
    pub mtime: Option<Timespec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Body {
    /// Sparse map of chunk-aligned offset -> content hash. A missing entry
    /// inside `size` is a hole and reads as zeroes.
    File { chunks: BTreeMap<u64, ChunkId> },
    Dir { entries: BTreeMap<Vec<u8>, Ino> },
    Symlink { target: Vec<u8> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inode {
    pub ino: Ino,
    pub parent: Ino,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub atime: Timespec,
    pub mtime: Timespec,
    pub ctime: Timespec,
    pub body: Body,
}

impl Inode {
    pub fn kind(&self) -> Kind {
        match self.body {
            Body::File { .. } => Kind::File,
            Body::Dir { .. } => Kind::Dir,
            Body::Symlink { .. } => Kind::Symlink,
        }
    }

    pub fn attr(&self) -> Attr {
        Attr {
            ino: self.ino,
            kind: self.kind(),
            mode: self.mode,
            nlink: match &self.body {
                // `.` plus one entry per child subdirectory, plus the parent's link.
                Body::Dir { entries } => 2 + entries.len() as u32,
                _ => 1,
            },
            uid: self.uid,
            gid: self.gid,
            size: self.size,
            atime: self.atime,
            mtime: self.mtime,
            ctime: self.ctime,
        }
    }
}

/// A single durable mutation. Anything that changes metadata is one of these,
/// and it hits the WAL before it hits memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Op {
    Create {
        ino: Ino,
        parent: Ino,
        name: Vec<u8>,
        kind: Kind,
        mode: u32,
        uid: u32,
        gid: u32,
        target: Option<Vec<u8>>,
        time: Timespec,
    },
    /// Install (or clear, when `chunk` is `None`) one chunk of a file.
    SetChunk {
        ino: Ino,
        offset: u64,
        chunk: Option<ChunkId>,
        size: u64,
        time: Timespec,
    },
    SetAttr {
        ino: Ino,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<Timespec>,
        mtime: Option<Timespec>,
        time: Timespec,
    },
    Remove {
        parent: Ino,
        name: Vec<u8>,
        time: Timespec,
    },
    Rename {
        from_parent: Ino,
        from_name: Vec<u8>,
        to_parent: Ino,
        to_name: Vec<u8>,
        time: Timespec,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaStore {
    inodes: BTreeMap<Ino, Inode>,
    next_ino: Ino,
}

impl Default for MetaStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MetaStore {
    /// A fresh filesystem: just a root directory.
    pub fn new() -> MetaStore {
        let now = Timespec::now();
        let root = Inode {
            ino: ROOT_INO,
            parent: ROOT_INO,
            mode: 0o755,
            uid: 0,
            gid: 0,
            size: 0,
            atime: now,
            mtime: now,
            ctime: now,
            body: Body::Dir { entries: BTreeMap::new() },
        };
        let mut inodes = BTreeMap::new();
        inodes.insert(ROOT_INO, root);
        MetaStore { inodes, next_ino: ROOT_INO + 1 }
    }

    pub fn alloc_ino(&mut self) -> Ino {
        let ino = self.next_ino;
        self.next_ino += 1;
        ino
    }

    pub fn get(&self, ino: Ino) -> Result<&Inode> {
        self.inodes.get(&ino).ok_or(FsError::NotFound)
    }

    pub fn get_mut(&mut self, ino: Ino) -> Result<&mut Inode> {
        self.inodes.get_mut(&ino).ok_or(FsError::NotFound)
    }

    pub fn len(&self) -> usize {
        self.inodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inodes.is_empty()
    }

    pub fn entries(&self, dir: Ino) -> Result<&BTreeMap<Vec<u8>, Ino>> {
        match &self.get(dir)?.body {
            Body::Dir { entries } => Ok(entries),
            _ => Err(FsError::NotDir),
        }
    }

    pub fn lookup(&self, dir: Ino, name: &[u8]) -> Result<Ino> {
        self.entries(dir)?.get(name).copied().ok_or(FsError::NotFound)
    }

    /// Every chunk currently referenced by any inode. The flusher uses this to
    /// know what must be durable in the object store before the WAL is cut.
    pub fn live_chunks(&self) -> Vec<ChunkId> {
        let mut out = Vec::new();
        for inode in self.inodes.values() {
            if let Body::File { chunks } = &inode.body {
                out.extend(chunks.values().copied());
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Apply a durable operation. This is the whole state machine; it must be
    /// deterministic and must not fail on a record that was accepted once
    /// already, or replay would diverge from the live state.
    pub fn apply(&mut self, op: &Op) -> Result<()> {
        match op {
            Op::Create { ino, parent, name, kind, mode, uid, gid, target, time } => {
                if self.inodes.contains_key(ino) {
                    return Err(FsError::Exists);
                }
                let body = match kind {
                    Kind::File => Body::File { chunks: BTreeMap::new() },
                    Kind::Dir => Body::Dir { entries: BTreeMap::new() },
                    Kind::Symlink => Body::Symlink {
                        target: target.clone().ok_or(FsError::Inval)?,
                    },
                };
                let size = match &body {
                    Body::Symlink { target } => target.len() as u64,
                    _ => 0,
                };
                let inode = Inode {
                    ino: *ino,
                    parent: *parent,
                    mode: *mode,
                    uid: *uid,
                    gid: *gid,
                    size,
                    atime: *time,
                    mtime: *time,
                    ctime: *time,
                    body,
                };
                match &mut self.get_mut(*parent)?.body {
                    Body::Dir { entries } => {
                        if entries.contains_key(name) {
                            return Err(FsError::Exists);
                        }
                        entries.insert(name.clone(), *ino);
                    }
                    _ => return Err(FsError::NotDir),
                }
                self.get_mut(*parent)?.mtime = *time;
                self.inodes.insert(*ino, inode);
                self.next_ino = self.next_ino.max(*ino + 1);
            }

            Op::SetChunk { ino, offset, chunk, size, time } => {
                let inode = self.get_mut(*ino)?;
                match &mut inode.body {
                    Body::File { chunks } => match chunk {
                        Some(id) => {
                            chunks.insert(*offset, *id);
                        }
                        None => {
                            chunks.remove(offset);
                        }
                    },
                    _ => return Err(FsError::IsDir),
                }
                inode.size = *size;
                inode.mtime = *time;
                inode.ctime = *time;
            }

            Op::SetAttr { ino, mode, uid, gid, size, atime, mtime, time } => {
                let inode = self.get_mut(*ino)?;
                if let Some(m) = mode {
                    inode.mode = *m;
                }
                if let Some(u) = uid {
                    inode.uid = *u;
                }
                if let Some(g) = gid {
                    inode.gid = *g;
                }
                if let Some(a) = atime {
                    inode.atime = *a;
                }
                if let Some(m) = mtime {
                    inode.mtime = *m;
                }
                if let Some(new_size) = size {
                    if let Body::File { chunks } = &mut inode.body {
                        // Drop chunks fully past the new EOF. A chunk straddling
                        // the boundary keeps its trailing bytes; reads clamp to
                        // `size`, so they stay invisible until overwritten.
                        chunks.retain(|off, _| *off < *new_size);
                    }
                    inode.size = *new_size;
                }
                inode.ctime = *time;
            }

            Op::Remove { parent, name, time } => {
                let ino = self.lookup(*parent, name)?;
                let victim = self.get(ino)?;
                if let Body::Dir { entries } = &victim.body
                    && !entries.is_empty() {
                        return Err(FsError::NotEmpty);
                    }
                if let Body::Dir { entries } = &mut self.get_mut(*parent)?.body {
                    entries.remove(name);
                }
                self.get_mut(*parent)?.mtime = *time;
                self.inodes.remove(&ino);
            }

            Op::Rename { from_parent, from_name, to_parent, to_name, time } => {
                let ino = self.lookup(*from_parent, from_name)?;
                // POSIX: renaming onto an existing name replaces it, but the
                // target must be empty if it is a directory.
                if let Ok(existing) = self.lookup(*to_parent, to_name)
                    && existing != ino {
                        if let Body::Dir { entries } = &self.get(existing)?.body
                            && !entries.is_empty() {
                                return Err(FsError::NotEmpty);
                            }
                        self.inodes.remove(&existing);
                    }
                if let Body::Dir { entries } = &mut self.get_mut(*from_parent)?.body {
                    entries.remove(from_name);
                }
                if let Body::Dir { entries } = &mut self.get_mut(*to_parent)?.body {
                    entries.insert(to_name.clone(), ino);
                } else {
                    return Err(FsError::NotDir);
                }
                self.get_mut(*from_parent)?.mtime = *time;
                self.get_mut(*to_parent)?.mtime = *time;
                let inode = self.get_mut(ino)?;
                inode.parent = *to_parent;
                inode.ctime = *time;
            }
        }
        Ok(())
    }
}

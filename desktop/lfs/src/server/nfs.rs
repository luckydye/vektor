//! NFSv3 adapter.
//!
//! The only job here is translation: NFS wire types in, engine calls out, and
//! engine errors mapped back to `nfsstat3`. No storage decisions are made in
//! this file, and the engine never sees an NFS type.

use std::sync::Arc;

use async_trait::async_trait;
use nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_atime, set_gid3,
    set_mode3, set_mtime, set_size3, set_uid3, specdata3,
};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};

use crate::error::FsError;
use crate::fs::FileSystem;
use crate::storage::meta::{Attr, Kind, SetAttr, Timespec};

pub struct NfsAdapter {
    volume: Arc<dyn FileSystem>,
}

impl NfsAdapter {
    pub fn new(volume: Arc<dyn FileSystem>) -> NfsAdapter {
        NfsAdapter { volume }
    }
}

fn stat(e: FsError) -> nfsstat3 {
    match e {
        FsError::NotFound => nfsstat3::NFS3ERR_NOENT,
        FsError::Exists => nfsstat3::NFS3ERR_EXIST,
        FsError::NotDir => nfsstat3::NFS3ERR_NOTDIR,
        FsError::IsDir => nfsstat3::NFS3ERR_ISDIR,
        FsError::NotEmpty => nfsstat3::NFS3ERR_NOTEMPTY,
        FsError::Inval => nfsstat3::NFS3ERR_INVAL,
        FsError::NoSpace => nfsstat3::NFS3ERR_NOSPC,
        FsError::ReadOnly => nfsstat3::NFS3ERR_ROFS,
        other => {
            tracing::error!("nfs: {other}");
            nfsstat3::NFS3ERR_IO
        }
    }
}

fn time(t: Timespec) -> nfstime3 {
    nfstime3 { seconds: t.secs as u32, nseconds: t.nanos }
}

fn fattr(a: Attr, filesystem_id: u64) -> fattr3 {
    let ftype = match a.kind {
        Kind::File => ftype3::NF3REG,
        Kind::Dir => ftype3::NF3DIR,
        Kind::Symlink => ftype3::NF3LNK,
    };
    fattr3 {
        ftype,
        mode: a.mode,
        nlink: a.nlink,
        uid: a.uid,
        gid: a.gid,
        size: a.size,
        // Space consumed, rounded to a 4K block as clients expect.
        used: a.size.div_ceil(4096) * 4096,
        rdev: specdata3::default(),
        fsid: filesystem_id,
        fileid: a.ino,
        atime: time(a.atime),
        mtime: time(a.mtime),
        ctime: time(a.ctime),
    }
}

fn set_attr(s: &sattr3) -> SetAttr {
    let now = Timespec::now();
    let stamp = |t: &set_atime| match t {
        set_atime::DONT_CHANGE => None,
        set_atime::SET_TO_SERVER_TIME => Some(now),
        set_atime::SET_TO_CLIENT_TIME(t) => {
            Some(Timespec { secs: t.seconds as u64, nanos: t.nseconds })
        }
    };
    let mstamp = |t: &set_mtime| match t {
        set_mtime::DONT_CHANGE => None,
        set_mtime::SET_TO_SERVER_TIME => Some(now),
        set_mtime::SET_TO_CLIENT_TIME(t) => {
            Some(Timespec { secs: t.seconds as u64, nanos: t.nseconds })
        }
    };
    SetAttr {
        mode: match s.mode {
            set_mode3::mode(m) => Some(m),
            set_mode3::Void => None,
        },
        uid: match s.uid {
            set_uid3::uid(u) => Some(u),
            set_uid3::Void => None,
        },
        gid: match s.gid {
            set_gid3::gid(g) => Some(g),
            set_gid3::Void => None,
        },
        size: match s.size {
            set_size3::size(v) => Some(v),
            set_size3::Void => None,
        },
        atime: stamp(&s.atime),
        mtime: mstamp(&s.mtime),
    }
}

fn mode_of(s: &sattr3, default: u32) -> u32 {
    match s.mode {
        set_mode3::mode(m) => m,
        set_mode3::Void => default,
    }
}

#[async_trait]
impl NFSFileSystem for NfsAdapter {
    fn capabilities(&self) -> VFSCapabilities {
        if self.volume.writable() {
            VFSCapabilities::ReadWrite
        } else {
            VFSCapabilities::ReadOnly
        }
    }

    fn root_dir(&self) -> fileid3 {
        self.volume.root()
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        // `.` and `..` are resolved here rather than stored in the namespace.
        match filename.0.as_slice() {
            b"." => return Ok(dirid),
            b".." => {
                return self
                    .volume
                    .getattr(dirid)
                    .await
                    .map_err(stat).map(|_| dirid)
            }
            _ => {}
        }
        self.volume.lookup(dirid, &filename.0).await.map_err(stat)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let filesystem_id = self.volume.filesystem_id();
        self.volume
            .getattr(id)
            .await
            .map(|a| fattr(a, filesystem_id))
            .map_err(stat)
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        let filesystem_id = self.volume.filesystem_id();
        self.volume
            .setattr(id, set_attr(&setattr))
            .await
            .map(|a| fattr(a, filesystem_id))
            .map_err(stat)
    }

    async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        self.volume.read(id, offset, count).await.map_err(stat)
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let attr = self.volume.write(id, offset, data).await.map_err(stat)?;
        if let Err(e) = self.volume.maybe_checkpoint().await {
            tracing::error!("checkpoint after write failed: {e}");
        }
        Ok(fattr(attr, self.volume.filesystem_id()))
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        // NFS CREATE is not exclusive by default: an existing file is truncated.
        if let Ok(existing) = self.volume.lookup(dirid, &filename.0).await {
            let mut set = set_attr(&attr);
            set.size = Some(0);
            let a = self.volume.setattr(existing, set).await.map_err(stat)?;
            return Ok((existing, fattr(a, self.volume.filesystem_id())));
        }
        self.volume
            .create(dirid, &filename.0, mode_of(&attr, 0o644))
            .await
            .map(|(id, a)| (id, fattr(a, self.volume.filesystem_id())))
            .map_err(stat)
    }

    async fn create_exclusive(
        &self,
        dirid: fileid3,
        filename: &filename3,
    ) -> Result<fileid3, nfsstat3> {
        self.volume
            .create(dirid, &filename.0, 0o644)
            .await
            .map(|(id, _)| id)
            .map_err(stat)
    }

    async fn mkdir(
        &self,
        dirid: fileid3,
        dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        self.volume
            .mkdir(dirid, &dirname.0, 0o755)
            .await
            .map(|(id, a)| (id, fattr(a, self.volume.filesystem_id())))
            .map_err(stat)
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        self.volume.remove(dirid, &filename.0).await.map_err(stat)
    }

    async fn rename(
        &self,
        from_dirid: fileid3,
        from_filename: &filename3,
        to_dirid: fileid3,
        to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        self.volume
            .rename(from_dirid, &from_filename.0, to_dirid, &to_filename.0)
            .await
            .map_err(stat)
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let (entries, end) = self
            .volume
            .readdir(dirid, start_after, max_entries)
            .await
            .map_err(|e| match e {
                // A cookie we no longer recognise, not a bad argument.
                FsError::Inval => nfsstat3::NFS3ERR_BAD_COOKIE,
                other => stat(other),
            })?;
        Ok(ReadDirResult {
            entries: entries
                .into_iter()
                .map(|(name, attr)| DirEntry {
                    fileid: attr.ino,
                    name: name.as_slice().into(),
                    attr: fattr(attr, self.volume.filesystem_id()),
                })
                .collect(),
            end,
        })
    }

    async fn symlink(
        &self,
        dirid: fileid3,
        linkname: &filename3,
        symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        self.volume
            .symlink(dirid, &linkname.0, &symlink.0)
            .await
            .map(|(id, a)| (id, fattr(a, self.volume.filesystem_id())))
            .map_err(stat)
    }

    async fn readlink(&self, id: fileid3) -> Result<nfspath3, nfsstat3> {
        self.volume
            .readlink(id)
            .await
            .map(|t| t.as_slice().into())
            .map_err(stat)
    }
}

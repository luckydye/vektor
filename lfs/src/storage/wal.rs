//! Write-ahead log, as a directory of numbered segments.
//!
//! Frame: `[u32 payload_len][u32 crc32(payload)][payload]`, little endian.
//! Replay stops at the first frame in a segment that is short or fails CRC:
//! a torn tail from a crash mid-append was never acknowledged, so discarding
//! it is correct.
//!
//! Segments exist so a checkpoint can seal the log (a cheap, lock-held
//! operation) and only afterwards do the slow object-store uploads, without
//! blocking writers or risking the loss of records appended meanwhile.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::Result;
use crate::storage::meta::Op;

const HEADER_LEN: usize = 8;
/// Refuse absurd frames rather than trying to allocate them.
const MAX_FRAME: u32 = 64 * 1024 * 1024;

pub struct Wal {
    dir: PathBuf,
    current: File,
    current_id: u64,
    bytes: u64,
}

fn segment_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("{id:012}.log"))
}

fn segment_ids(dir: &Path) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        if let Some(stem) = name.strip_suffix(".log")
            && let Ok(id) = stem.parse::<u64>() {
                ids.push(id);
            }
    }
    ids.sort_unstable();
    Ok(ids)
}

impl Wal {
    /// Open the log directory and replay every surviving record, in order.
    /// Appends go to a fresh segment, so replayed segments are never reopened
    /// for writing.
    pub fn open(dir: &Path) -> Result<(Wal, Vec<Op>)> {
        std::fs::create_dir_all(dir)?;
        let ids = segment_ids(dir)?;

        let mut ops = Vec::new();
        for id in &ids {
            ops.extend(replay_segment(&segment_path(dir, *id))?);
        }

        let current_id = ids.last().copied().unwrap_or(0) + 1;
        let current = OpenOptions::new().create(true).append(true).open(segment_path(dir, current_id))?;
        Ok((Wal { dir: dir.to_path_buf(), current, current_id, bytes: 0 }, ops))
    }

    /// Append records to the log without forcing them to disk.
    ///
    /// Durability is a separate step on purpose: fsync is by far the most
    /// expensive thing this filesystem does, so callers batch one sync across
    /// many appends rather than paying for it per write. Nothing may be
    /// acknowledged to a client until [`Wal::sync_handle`] has been synced.
    pub fn append(&mut self, ops: &[Op]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        let mut buf = Vec::new();
        for op in ops {
            let payload = postcard::to_stdvec(op)?;
            buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            buf.extend_from_slice(&crc32fast::hash(&payload).to_le_bytes());
            buf.extend_from_slice(&payload);
        }
        self.current.write_all(&buf)?;
        self.bytes += buf.len() as u64;
        Ok(())
    }

    /// A handle on the current segment that can be fsynced independently of
    /// the lock guarding appends. Syncing it makes every byte written before
    /// the call durable, which is what lets one sync cover many appends.
    pub fn sync_handle(&self) -> Result<Arc<File>> {
        Ok(Arc::new(self.current.try_clone()?))
    }

    /// Bytes appended to the current segment.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Seal the current segment and start a new one. Returns the id of the
    /// sealed segment: everything up to and including it is covered by the
    /// state the caller just snapshotted.
    pub fn rotate(&mut self) -> Result<u64> {
        let sealed = self.current_id;
        self.current.sync_all()?;
        self.current_id += 1;
        self.current = OpenOptions::new()
            .create(true)
            .append(true)
            .open(segment_path(&self.dir, self.current_id))?;
        self.bytes = 0;
        Ok(sealed)
    }

    /// Drop segments up to and including `id`. Only legal once a checkpoint
    /// covering every record in them is durable in the object store.
    pub fn discard_through(&self, id: u64) -> Result<()> {
        for seg in segment_ids(&self.dir)? {
            if seg <= id {
                std::fs::remove_file(segment_path(&self.dir, seg))?;
            }
        }
        Ok(())
    }
}

fn replay_segment(path: &Path) -> Result<Vec<Op>> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut reader = BufReader::new(file);
    let mut ops = Vec::new();
    let mut header = [0u8; HEADER_LEN];
    let mut valid_bytes: u64 = 0;

    loop {
        if reader.read_exact(&mut header).is_err() {
            break; // clean EOF, or a truncated header
        }
        let len = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let crc = u32::from_le_bytes(header[4..8].try_into().unwrap());
        if len == 0 || len > MAX_FRAME {
            break;
        }
        let mut payload = vec![0u8; len as usize];
        if reader.read_exact(&mut payload).is_err() {
            break;
        }
        if crc32fast::hash(&payload) != crc {
            tracing::warn!("wal: torn tail in {} at offset {valid_bytes}", path.display());
            break;
        }
        match postcard::from_bytes::<Op>(&payload) {
            Ok(op) => ops.push(op),
            Err(e) => {
                tracing::warn!("wal: undecodable record in {} at {valid_bytes}: {e}", path.display());
                break;
            }
        }
        valid_bytes += (HEADER_LEN + payload.len()) as u64;
    }

    // Drop anything after the last good record so the file matches what we
    // actually replayed.
    let actual = std::fs::metadata(path)?.len();
    if actual > valid_bytes {
        tracing::warn!("wal: truncating {} trailing bytes in {}", actual - valid_bytes, path.display());
        let f = OpenOptions::new().write(true).open(path)?;
        f.set_len(valid_bytes)?;
        f.sync_all()?;
    }
    let _ = valid_bytes;
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::meta::{Kind, Timespec};

    fn op(n: u64) -> Op {
        Op::Create {
            ino: n,
            parent: 1,
            name: format!("f{n}").into_bytes(),
            kind: Kind::File,
            mode: 0o644,
            uid: 0,
            gid: 0,
            target: None,
            time: Timespec::default(),
        }
    }

    #[test]
    fn round_trips_across_reopen() {
        let dir = tempdir();
        let (mut wal, ops) = Wal::open(&dir).unwrap();
        assert!(ops.is_empty());
        wal.append(&[op(2), op(3)]).unwrap();
        wal.sync_handle().unwrap().sync_data().unwrap();
        drop(wal);

        let (_wal, ops) = Wal::open(&dir).unwrap();
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn discards_a_torn_tail() {
        let dir = tempdir();
        let (mut wal, _) = Wal::open(&dir).unwrap();
        wal.append(&[op(2)]).unwrap();
        wal.append(&[op(3)]).unwrap();
        drop(wal);

        // Simulate a crash halfway through the last frame.
        let seg = segment_path(&dir, 1);
        let len = std::fs::metadata(&seg).unwrap().len();
        OpenOptions::new().write(true).open(&seg).unwrap().set_len(len - 3).unwrap();

        let (_wal, ops) = Wal::open(&dir).unwrap();
        assert_eq!(ops.len(), 1, "the torn record must not be replayed");
    }

    #[test]
    fn rotation_preserves_records_and_discard_drops_them() {
        let dir = tempdir();
        let (mut wal, _) = Wal::open(&dir).unwrap();
        wal.append(&[op(2)]).unwrap();
        let sealed = wal.rotate().unwrap();
        wal.append(&[op(3)]).unwrap();
        drop(wal);

        let (wal, ops) = Wal::open(&dir).unwrap();
        assert_eq!(ops.len(), 2);
        wal.discard_through(sealed).unwrap();
        drop(wal);

        let (_wal, ops) = Wal::open(&dir).unwrap();
        assert_eq!(ops.len(), 1, "only the post-checkpoint record survives");
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("lfs-wal-{}", uuid()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn uuid() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("{n}-{:?}", std::thread::current().id())
            .replace(['(', ')', ' '], "")
    }
}

//! Immutable, content-addressed file chunks.
//!
//! A chunk's name is the BLAKE3 hash of its bytes, so a chunk is never
//! modified, deduplicates for free, and can be cached indefinitely without
//! invalidation.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Chunk granularity. Writes smaller than this become read-modify-write, so it
/// trades write amplification against per-chunk overhead in the object store.
pub const CHUNK_SIZE: u64 = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ChunkId(pub [u8; 32]);

impl ChunkId {
    pub fn of(data: &[u8]) -> ChunkId {
        ChunkId(*blake3::hash(data).as_bytes())
    }

    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    /// `ab/cdef...` — fanned out so a directory cache never holds millions of
    /// entries in one directory.
    pub fn key(self) -> String {
        let hex = self.to_hex();
        format!("{}/{}", &hex[0..2], &hex[2..])
    }
}

impl fmt::Debug for ChunkId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "chunk:{}", &self.to_hex()[..12])
    }
}

/// Split a byte range into (chunk offset, offset within chunk, length) pieces.
pub fn split_range(offset: u64, len: u64) -> Vec<(u64, u64, u64)> {
    let mut out = Vec::new();
    let mut pos = offset;
    let end = offset + len;
    while pos < end {
        let chunk_off = (pos / CHUNK_SIZE) * CHUNK_SIZE;
        let within = pos - chunk_off;
        let take = (CHUNK_SIZE - within).min(end - pos);
        out.push((chunk_off, within, take));
        pos += take;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_chunk_boundaries() {
        assert_eq!(split_range(0, 10), vec![(0, 0, 10)]);
        assert_eq!(
            split_range(CHUNK_SIZE - 5, 10),
            vec![(0, CHUNK_SIZE - 5, 5), (CHUNK_SIZE, 0, 5)]
        );
        assert_eq!(split_range(0, 0), vec![]);
    }

    #[test]
    fn hashing_is_content_addressed() {
        assert_eq!(ChunkId::of(b"hello"), ChunkId::of(b"hello"));
        assert_ne!(ChunkId::of(b"hello"), ChunkId::of(b"world"));
    }
}

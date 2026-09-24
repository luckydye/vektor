//! The interface the protocol front ends are written against.
//!
//! There are two implementations: [`Volume`](crate::fs::Volume), the WAL-backed
//! filesystem stored in an object store, and
//! [`Passthrough`](crate::fs::passthrough::Passthrough), which presents objects
//! that are already in a bucket as files. The front ends cannot tell them
//! apart, which is the same layering rule applied once more.

use async_trait::async_trait;

use crate::error::Result;
use crate::storage::meta::{Attr, Ino, SetAttr};

#[async_trait]
pub trait FileSystem: Send + Sync {
    /// Name of this filesystem, used as the NFS export and SMB share.
    fn name(&self) -> &str;

    /// Where the data lives, for display.
    fn location(&self) -> &str;

    /// Stable identity of this logical filesystem. Protocol front ends expose
    /// this to clients, which use it together with inode numbers for durable
    /// file references and cache keys.
    fn filesystem_id(&self) -> u64;

    fn root(&self) -> Ino;

    /// Whether mutating calls can succeed at all. Front ends advertise this so
    /// a client can mount read-only cleanly rather than discovering it on the
    /// first failed write.
    fn writable(&self) -> bool {
        true
    }

    async fn lookup(&self, parent: Ino, name: &[u8]) -> Result<Ino>;
    async fn getattr(&self, ino: Ino) -> Result<Attr>;
    async fn parent(&self, ino: Ino) -> Result<Ino>;
    async fn readdir(
        &self,
        dir: Ino,
        start_after: Ino,
        max_entries: usize,
    ) -> Result<(Vec<(Vec<u8>, Attr)>, bool)>;
    async fn read(&self, ino: Ino, offset: u64, count: u32) -> Result<(Vec<u8>, bool)>;
    async fn readlink(&self, ino: Ino) -> Result<Vec<u8>>;

    async fn setattr(&self, ino: Ino, set: SetAttr) -> Result<Attr>;
    async fn write(&self, ino: Ino, offset: u64, data: &[u8]) -> Result<Attr>;
    async fn create(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)>;
    async fn mkdir(&self, parent: Ino, name: &[u8], mode: u32) -> Result<(Ino, Attr)>;
    async fn symlink(&self, parent: Ino, name: &[u8], target: &[u8]) -> Result<(Ino, Attr)>;
    async fn remove(&self, parent: Ino, name: &[u8]) -> Result<()>;
    async fn rename(
        &self,
        from_parent: Ino,
        from_name: &[u8],
        to_parent: Ino,
        to_name: &[u8],
    ) -> Result<()>;

    /// Hint that now is a reasonable moment to make things durable. A
    /// read-only filesystem does nothing.
    async fn maybe_checkpoint(&self) -> Result<()> {
        Ok(())
    }

    /// Push everything still buffered to its backing store and wait for it.
    ///
    /// A filesystem that acknowledges a write only once it is durable has
    /// nothing to do here. One that buffers — because its backing store takes
    /// whole objects and cannot be written in place — uses this to make good on
    /// the writes it has already acknowledged, and must be given the chance
    /// before the process exits.
    async fn sync(&self) -> Result<()> {
        Ok(())
    }
}

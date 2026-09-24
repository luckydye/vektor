//! Storage engine: durable mutations (WAL), the metadata state machine,
//! content-addressed chunks, a local cache, and the object-store backing.
//!
//! Nothing in this module knows that NFS exists.

pub mod backend;
pub mod cache;
pub mod chunk;
pub mod meta;
pub mod wal;

//! lfs — a WAL-backed filesystem persisted to object storage, exposed over a
//! protocol the host OS can mount natively.
//!
//! The layering is the point:
//!
//! ```text
//!   server::nfs   protocol translation only
//!        |
//!      fs         POSIX-ish semantics: inodes, namespace, read/write
//!        |
//!    storage      WAL, metadata state machine, chunks, cache, object store
//! ```
//!
//! `storage` knows nothing about NFS, and `server` knows nothing about S3.

pub mod client;
pub mod error;
pub mod fs;
pub mod server;
pub mod storage;

pub use error::{FsError, Result};
pub use fs::Volume;

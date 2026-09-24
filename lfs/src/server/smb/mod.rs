//! SMB2 front end.
//!
//! Same rule as the NFS adapter: this layer translates SMB wire types to
//! engine calls and back, and nothing below it knows SMB exists. It is a
//! second front end rather than a replacement, because Windows mounts SMB
//! natively on every edition while its NFS client is an optional feature
//! missing from Home (see `docs/platforms.md`).

pub mod info;
pub mod ntlm;
pub mod server;
pub mod session;
pub mod wire;

pub use ntlm::Credentials;
pub use server::serve_smb;

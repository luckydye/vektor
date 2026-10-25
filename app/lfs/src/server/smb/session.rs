//! Per-connection state: the authentication handshake, packet signing, open
//! file handles, and the path-to-inode resolution SMB needs.

use std::collections::HashMap;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::{FsError, Result};
use crate::fs::FileSystem;
use crate::storage::meta::{Ino, Kind};

use super::wire::{HEADER_LEN, SMB2_FLAGS_SIGNED};

type HmacSha256 = Hmac<Sha256>;

pub const DIALECT_2_1: u16 = 0x0210;
pub const DIALECT_3_0_2: u16 = 0x0302;

/// An open file or directory.
pub struct Handle {
    pub ino: Ino,
    pub kind: Kind,
    /// Path as the client named it, needed because SMB deletes and renames are
    /// expressed against an open handle rather than a parent plus name.
    pub path: String,
    /// Cached listing for a QUERY_DIRECTORY sequence, which pages until the
    /// server reports no more files.
    pub dir_cursor: Option<Vec<(Vec<u8>, Ino)>>,
    /// The search pattern the current scan was opened with. Clients use a
    /// single-name pattern as their `stat`, so ignoring it makes lookups fail.
    pub dir_pattern: String,
    pub dir_index: usize,
    /// Set by SET_INFO with FileDispositionInformation; acted on at CLOSE.
    pub delete_on_close: bool,
}

pub struct Connection {
    pub volume: Arc<dyn FileSystem>,
    pub dialect: u16,
    pub server_challenge: [u8; 8],
    pub session_id: u64,
    pub authenticated: bool,
    pub signing_key: Option<[u8; 16]>,
    pub tree_ids: HashMap<u32, String>,
    handles: HashMap<u64, Handle>,
    next_handle: u64,
}

impl Connection {
    pub fn new(volume: Arc<dyn FileSystem>) -> Connection {
        Connection {
            volume,
            dialect: DIALECT_2_1,
            server_challenge: rand::random(),
            // Any non-zero value works; clients echo it back on every request.
            session_id: 0x1000_0000_0000_0001,
            authenticated: false,
            signing_key: None,
            tree_ids: HashMap::new(),
            handles: HashMap::new(),
            next_handle: 1,
        }
    }

    // ---- handles ----

    pub fn open_handle(&mut self, handle: Handle) -> u64 {
        let id = self.next_handle;
        self.next_handle += 1;
        self.handles.insert(id, handle);
        id
    }

    pub fn handle(&self, id: u64) -> Option<&Handle> {
        self.handles.get(&id)
    }

    pub fn handle_mut(&mut self, id: u64) -> Option<&mut Handle> {
        self.handles.get_mut(&id)
    }

    pub fn close_handle(&mut self, id: u64) -> Option<Handle> {
        self.handles.remove(&id)
    }

    // ---- signing ----

    /// Sign a response in place.
    ///
    /// The signature covers the whole message with the signature field itself
    /// zeroed, so it must be computed after every other byte is final.
    pub fn sign(&self, packet: &mut [u8]) {
        let Some(key) = self.signing_key else { return };
        if packet.len() < HEADER_LEN {
            return;
        }
        // Mark as signed and clear the field before computing over it.
        let flags = u32::from_le_bytes(packet[16..20].try_into().unwrap());
        packet[16..20].copy_from_slice(&(flags | SMB2_FLAGS_SIGNED).to_le_bytes());
        packet[48..64].fill(0);

        let signature = match self.dialect {
            d if d >= DIALECT_3_0_2 => sign_aes_cmac(&key, packet),
            _ => sign_hmac_sha256(&key, packet),
        };
        packet[48..64].copy_from_slice(&signature);
    }

    /// Verify a client's signature. A request that fails this is dropped rather
    /// than answered, since a valid session id with a bad signature is either
    /// corruption or tampering.
    pub fn verify_signature(&self, packet: &[u8]) -> bool {
        let Some(key) = self.signing_key else { return true };
        if packet.len() < HEADER_LEN {
            return false;
        }
        let flags = u32::from_le_bytes(packet[16..20].try_into().unwrap());
        if flags & SMB2_FLAGS_SIGNED == 0 {
            return true; // client chose not to sign this one
        }
        let mut claimed = [0u8; 16];
        claimed.copy_from_slice(&packet[48..64]);

        let mut copy = packet.to_vec();
        copy[48..64].fill(0);
        let expected = match self.dialect {
            d if d >= DIALECT_3_0_2 => sign_aes_cmac(&key, &copy),
            _ => sign_hmac_sha256(&key, &copy),
        };
        expected
            .iter()
            .zip(claimed.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }

    // ---- path resolution ----

    /// Resolve an SMB path (backslash separated, relative to the share root)
    /// to an inode.
    pub async fn resolve(&self, path: &str) -> Result<Ino> {
        let mut ino = self.volume.root();
        for part in split_path(path) {
            ino = self.volume.lookup(ino, part.as_bytes()).await?;
        }
        Ok(ino)
    }

    /// Resolve the parent directory of a path, returning it with the final
    /// component. Used by create, rename, and delete.
    pub async fn resolve_parent(&self, path: &str) -> Result<(Ino, String)> {
        let parts = split_path(path);
        let Some((name, dirs)) = parts.split_last() else {
            return Err(FsError::Inval);
        };
        let mut ino = self.volume.root();
        for part in dirs {
            ino = self.volume.lookup(ino, part.as_bytes()).await?;
        }
        Ok((ino, name.clone()))
    }
}

/// Split an SMB path into components, tolerating either separator and ignoring
/// empty segments and the `.` the client sometimes sends for the share root.
pub fn split_path(path: &str) -> Vec<String> {
    path.split(['\\', '/'])
        .filter(|p| !p.is_empty() && *p != ".")
        .map(|p| p.to_string())
        .collect()
}

fn sign_hmac_sha256(key: &[u8; 16], packet: &[u8]) -> [u8; 16] {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(packet);
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

fn sign_aes_cmac(key: &[u8; 16], packet: &[u8]) -> [u8; 16] {
    use cmac::Cmac;
    let mut mac = <Cmac<aes::Aes128> as Mac>::new_from_slice(key).expect("aes-128 key is 16 bytes");
    mac.update(packet);
    mac.finalize().into_bytes().into()
}

/// SP800-108 counter-mode KDF, used by SMB 3.x to derive per-purpose keys from
/// the session key rather than using it directly.
pub fn kdf(key: &[u8; 16], label: &[u8], context: &[u8]) -> [u8; 16] {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(&1u32.to_be_bytes());
    mac.update(label);
    mac.update(&[0]);
    mac.update(context);
    mac.update(&128u32.to_be_bytes());
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_on_either_separator() {
        assert_eq!(split_path("\\a\\b\\c"), vec!["a", "b", "c"]);
        assert_eq!(split_path("a/b"), vec!["a", "b"]);
        assert!(split_path("").is_empty());
        assert!(split_path(".").is_empty(), "the share root must resolve to no components");
    }

    #[test]
    fn signing_detects_tampering() {
        let key = [7u8; 16];
        let mut packet = vec![0u8; 128];
        packet[0..4].copy_from_slice(&[0xFE, b'S', b'M', b'B']);
        let sig = sign_hmac_sha256(&key, &packet);
        packet[100] ^= 1;
        assert_ne!(sign_hmac_sha256(&key, &packet), sig);
    }
}

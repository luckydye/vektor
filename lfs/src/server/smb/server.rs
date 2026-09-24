//! SMB2 transport, request dispatch, and the negotiate/authenticate/connect
//! handshake.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::error::{FsError, Result};
use crate::fs::FileSystem;

use super::info;
use super::ntlm::{self, Credentials};
use super::session::{Connection, DIALECT_2_1, DIALECT_3_0_2};
use super::wire::*;

/// NetBIOS session service framing: one zero byte then a 24-bit length.
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

/// SMB1 protocol id, `\xFFSMB`. Only ever seen on the very first packet.
const SMB1_MAGIC: [u8; 4] = [0xFF, b'S', b'M', b'B'];
const SMB1_COM_NEGOTIATE: u8 = 0x72;
/// The "any SMB2 dialect" revision, used to answer an SMB1 negotiate and get
/// the client to start over in SMB2.
const DIALECT_WILDCARD: u16 = 0x02FF;

/// Advertised transfer sizes. Chosen to be a multiple of the engine's chunk
/// size so a full-size client write lands on chunk boundaries instead of
/// forcing a read-modify-write on both ends.
const MAX_READ: u32 = 1024 * 1024;
const MAX_WRITE: u32 = 1024 * 1024;
const MAX_TRANSACT: u32 = 1024 * 1024;

const SMB2_NEGOTIATE_SIGNING_ENABLED: u16 = 0x0001;

/// Everything a share can grant.
pub const FULL_ACCESS: u32 = 0x001F_01FF;
/// Read, list, traverse, and read attributes — no write, delete, or rename.
pub const READ_ACCESS: u32 = 0x0012_0089;

/// Bind an SMB server. Port 445 is the standard and what Windows and macOS
/// clients assume; binding it needs privilege, so the port is configurable for
/// testing.
pub async fn serve_smb(
    volume: Arc<dyn FileSystem>,
    addr: &str,
    share: String,
    creds: Credentials,
) -> Result<(u16, impl std::future::Future<Output = Result<()>> + Send + use<>)> {
    let listener = TcpListener::bind(addr).await.map_err(FsError::Io)?;
    let port = listener.local_addr().map_err(FsError::Io)?.port();

    Ok((port, async move {
        loop {
            let (socket, peer) = listener.accept().await.map_err(FsError::Io)?;
            let volume = Arc::clone(&volume);
            let share = share.clone();
            let creds = creds.clone();
            tokio::spawn(async move {
                tracing::debug!("smb: connection from {peer}");
                if let Err(e) = handle_connection(socket, volume, share, creds).await {
                    tracing::debug!("smb: connection from {peer} ended: {e}");
                }
            });
        }
    }))
}

async fn handle_connection(
    mut socket: TcpStream,
    volume: Arc<dyn FileSystem>,
    share: String,
    creds: Credentials,
) -> Result<()> {
    socket.set_nodelay(true).map_err(FsError::Io)?;
    let mut conn = Connection::new(volume);

    loop {
        let mut prefix = [0u8; 4];
        if socket.read_exact(&mut prefix).await.is_err() {
            return Ok(()); // client hung up
        }
        let len = u32::from_be_bytes(prefix) as usize & 0x00FF_FFFF;
        if len == 0 || len > MAX_MESSAGE {
            return Err(FsError::Backend(format!("smb: bad message length {len}")));
        }
        let mut message = vec![0u8; len];
        socket.read_exact(&mut message).await.map_err(FsError::Io)?;

        tracing::debug!(
            "smb: <- {} bytes, magic {:02x?}, command {:#06x}",
            message.len(),
            &message[..4.min(message.len())],
            Header::parse(&message).map(|h| h.command).unwrap_or(0xFFFF)
        );

        // Clients still open with an SMB1 multi-protocol negotiate listing
        // "SMB 2.???" among its dialects. macOS always does; Windows does
        // unless SMB1 is fully removed. The documented answer is an *SMB2*
        // negotiate response with the wildcard revision, after which the client
        // restarts the handshake in SMB2 and SMB1 is never spoken again.
        if message.len() >= 5 && message[0..4] == SMB1_MAGIC {
            if message[4] != SMB1_COM_NEGOTIATE || !offers_smb2(&message) {
                return Err(FsError::Backend("smb: client offered only SMB1".into()));
            }
            tracing::debug!("smb: upgrading SMB1 negotiate to SMB2");
            let response = smb1_upgrade_response(conn.volume.filesystem_id());
            let mut framed = Vec::with_capacity(4 + response.len());
            framed.extend_from_slice(&(response.len() as u32).to_be_bytes());
            framed.extend_from_slice(&response);
            socket.write_all(&framed).await.map_err(FsError::Io)?;
            continue;
        }

        let Some(response) = dispatch_compound(&mut conn, &message, &share, &creds).await else {
            continue; // CANCEL and friends produce no reply
        };

        let mut framed = Vec::with_capacity(4 + response.len());
        framed.extend_from_slice(&(response.len() as u32).to_be_bytes());
        framed.extend_from_slice(&response);
        socket.write_all(&framed).await.map_err(FsError::Io)?;
    }
}

/// Does an SMB1 negotiate list any SMB2 dialect?
///
/// The dialect list is a run of `0x02` followed by NUL-terminated ASCII names,
/// starting after the 32-byte header, a word count, and a byte count.
fn offers_smb2(message: &[u8]) -> bool {
    const DIALECT_LIST_START: usize = 35;
    message
        .get(DIALECT_LIST_START..)
        .map(|body| {
            body.split(|b| *b == 0)
                .any(|name| name.ends_with(b"SMB 2.???") || name.ends_with(b"SMB 2.002"))
        })
        .unwrap_or(false)
}

/// An SMB2 NEGOTIATE response carrying the wildcard dialect, synthesised
/// without a request header since the request was SMB1.
fn smb1_upgrade_response(filesystem_id: u64) -> Vec<u8> {
    let blob = ntlm::spnego_neg_token_init();
    let header = Header { command: SMB2_NEGOTIATE, message_id: 0, ..Header::default() };

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, 1);
    w.u16(65);
    w.u16(SMB2_NEGOTIATE_SIGNING_ENABLED);
    w.u16(DIALECT_WILDCARD);
    w.u16(0);
    w.bytes(&server_guid(filesystem_id));
    w.u32(0);
    w.u32(MAX_TRANSACT);
    w.u32(MAX_READ);
    w.u32(MAX_WRITE);
    w.u64(0); // system time
    w.u64(0); // server start time
    let offset_at = w.len();
    w.u16(0);
    w.u16(blob.len() as u16);
    w.u32(0);
    let blob_at = w.len();
    w.bytes(&blob);
    w.patch_u16(offset_at, blob_at as u16);
    w.buf
}

/// Walk a compound chain, producing one concatenated response.
///
/// Clients routinely send CREATE + QUERY_INFO + CLOSE as a single message, and
/// a server that answers only the first request will appear to hang.
async fn dispatch_compound(
    conn: &mut Connection,
    message: &[u8],
    share: &str,
    creds: &Credentials,
) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut offset = 0usize;
    // A related request inherits the previous one's file id.
    let mut last_handle: u64 = 0;

    loop {
        let packet = &message[offset..];
        let header = Header::parse(packet)?;
        let end = if header.next_command > 0 {
            (header.next_command as usize).min(packet.len())
        } else {
            packet.len()
        };
        let request = &packet[..end];

        if !conn.verify_signature(request) {
            tracing::warn!("smb: signature check failed, dropping request");
            return None;
        }

        let mut response = dispatch(conn, &header, request, share, creds, &mut last_handle).await?;

        if header.next_command > 0 {
            // Each response but the last points at the next, 8-byte aligned.
            while response.len() % 8 != 0 {
                response.push(0);
            }
            let next = response.len() as u32;
            response[20..24].copy_from_slice(&next.to_le_bytes());
        }
        conn.sign(&mut response);
        out.extend_from_slice(&response);

        if header.next_command == 0 {
            break;
        }
        offset += header.next_command as usize;
        if offset >= message.len() {
            break;
        }
    }
    Some(out)
}

async fn dispatch(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    share: &str,
    creds: &Credentials,
    last_handle: &mut u64,
) -> Option<Vec<u8>> {
    // Everything past the handshake requires a session.
    let needs_session = !matches!(header.command, SMB2_NEGOTIATE | SMB2_SESSION_SETUP);
    if needs_session && !conn.authenticated {
        return Some(error_response(header, STATUS_USER_SESSION_DELETED));
    }

    let result = match header.command {
        SMB2_NEGOTIATE => negotiate(conn, header, request),
        SMB2_SESSION_SETUP => session_setup(conn, header, request, creds),
        SMB2_LOGOFF => {
            conn.authenticated = false;
            Ok(simple_response(header, 4, |w| {
                w.u16(4).u16(0);
            }))
        }
        SMB2_TREE_CONNECT => tree_connect(conn, header, request, share),
        SMB2_TREE_DISCONNECT => Ok(simple_response(header, 4, |w| {
            w.u16(4).u16(0);
        })),
        SMB2_ECHO => Ok(simple_response(header, 4, |w| {
            w.u16(4).u16(0);
        })),
        SMB2_CANCEL => return None, // no response is the correct behaviour
        SMB2_CREATE => info::create(conn, header, request, last_handle).await,
        SMB2_CLOSE => info::close(conn, header, request, last_handle).await,
        SMB2_FLUSH => Ok(simple_response(header, 4, |w| {
            w.u16(4).u16(0);
        })),
        SMB2_READ => info::read(conn, header, request, last_handle).await,
        SMB2_WRITE => info::write(conn, header, request, last_handle).await,
        SMB2_QUERY_DIRECTORY => info::query_directory(conn, header, request, last_handle).await,
        SMB2_QUERY_INFO => info::query_info(conn, header, request, last_handle).await,
        SMB2_SET_INFO => info::set_info(conn, header, request, last_handle).await,
        SMB2_LOCK => Ok(simple_response(header, 4, |w| {
            // No byte-range locking; see docs/platforms.md. Reporting success
            // keeps clients working, with the same single-writer caveat NFS has.
            w.u16(4).u16(0);
        })),
        SMB2_IOCTL | SMB2_CHANGE_NOTIFY => Ok(error_response(header, STATUS_NOT_SUPPORTED)),
        other => {
            tracing::debug!("smb: unhandled command {other:#06x}");
            Ok(error_response(header, STATUS_NOT_IMPLEMENTED))
        }
    };

    Some(match result {
        Ok(response) => response,
        Err(status) => error_response(header, status),
    })
}

// ---- handshake ----

fn negotiate(conn: &mut Connection, header: &Header, request: &[u8]) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2); // structure size
    let dialect_count = r.u16() as usize;
    // SecurityMode(2) Reserved(2) Capabilities(4) ClientGuid(16), then 8 bytes
    // that are ClientStartTime before 3.1.1 and negotiate-context fields after.
    r.skip(2 + 2 + 4 + 16 + 8);

    let mut offered = Vec::with_capacity(dialect_count);
    for _ in 0..dialect_count {
        offered.push(r.u16());
    }

    // Prefer 3.0.2, fall back to 2.1. SMB 3.1.1 is deliberately not offered: it
    // adds pre-auth integrity negotiate contexts, which are a separate piece of
    // work from everything else here.
    conn.dialect = if offered.contains(&DIALECT_3_0_2) {
        DIALECT_3_0_2
    } else if offered.contains(&DIALECT_2_1) {
        DIALECT_2_1
    } else {
        return Err(STATUS_NOT_SUPPORTED);
    };
    tracing::debug!("smb: negotiated dialect {:#06x}", conn.dialect);

    let blob = ntlm::spnego_neg_token_init();
    let now = crate::storage::meta::Timespec::now();

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(65);
    w.u16(SMB2_NEGOTIATE_SIGNING_ENABLED);
    w.u16(conn.dialect);
    w.u16(0); // negotiate context count
    w.bytes(&server_guid(conn.volume.filesystem_id()));
    w.u32(0); // capabilities: no leasing, no multi-channel, no persistent handles
    w.u32(MAX_TRANSACT);
    w.u32(MAX_READ);
    w.u32(MAX_WRITE);
    w.u32(filetime(now.secs, now.nanos) as u32);
    w.u32((filetime(now.secs, now.nanos) >> 32) as u32);
    w.u64(0); // server start time
    let offset_at = w.len();
    w.u16(0); // security buffer offset, patched below
    w.u16(blob.len() as u16);
    w.u32(0); // negotiate context offset
    let blob_at = w.len();
    w.bytes(&blob);
    w.patch_u16(offset_at, blob_at as u16);
    Ok(w.buf)
}

fn session_setup(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    creds: &Credentials,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2 + 1 + 1 + 4 + 4); // structure size, flags, security mode, caps, channel
    let blob_offset = r.u16() as usize;
    let blob_len = r.u16() as usize;
    let blob = r.view(blob_offset, blob_len);

    let Some(token) = ntlm::find_ntlm_message(blob) else {
        return Err(STATUS_LOGON_FAILURE);
    };

    if ntlm::is_negotiate(token) {
        // Step one: answer with a challenge and ask the client to continue.
        let challenge = ntlm::challenge(&conn.server_challenge, "LFS", &creds.domain);
        let response_blob = ntlm::spnego_neg_token_resp(&challenge);
        return Ok(session_setup_response(
            conn,
            header,
            STATUS_MORE_PROCESSING_REQUIRED,
            &response_blob,
        ));
    }

    if ntlm::is_authenticate(token) {
        let Some(auth) = ntlm::verify(token, &conn.server_challenge, creds) else {
            tracing::warn!("smb: authentication failed");
            return Err(STATUS_LOGON_FAILURE);
        };
        tracing::info!("smb: authenticated as {}", auth.user);

        conn.authenticated = true;
        // SMB 3.x derives a distinct signing key; 2.x signs with the session
        // key directly.
        conn.signing_key = Some(if conn.dialect >= DIALECT_3_0_2 {
            super::session::kdf(&auth.session_key, b"SMB2AESCMAC\0", b"SmbSign\0")
        } else {
            auth.session_key
        });

        let blob = ntlm::spnego_accept_completed();
        // The response that completes authentication is itself signed with the
        // key just established, which is how the client confirms the server
        // knows the password too.
        return Ok(session_setup_response(conn, header, STATUS_SUCCESS, &blob));
    }

    Err(STATUS_LOGON_FAILURE)
}

fn session_setup_response(
    conn: &Connection,
    header: &Header,
    status: u32,
    blob: &[u8],
) -> Vec<u8> {
    let mut reply = *header;
    reply.session_id = conn.session_id;

    let mut w = Writer::new();
    reply.write_response(&mut w, status, header.credits.max(1));
    w.u16(9);
    w.u16(0); // session flags: not guest, not anonymous
    let offset_at = w.len();
    w.u16(0);
    w.u16(blob.len() as u16);
    let blob_at = w.len();
    w.bytes(blob);
    w.patch_u16(offset_at, blob_at as u16);
    w.buf
}

fn tree_connect(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    share: &str,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2 + 2);
    let path_offset = r.u16() as usize;
    let path_len = r.u16() as usize;
    let path = utf16_to_string(r.view(path_offset, path_len));

    // Path is \\server\share; only the last component identifies the share.
    let requested = path.rsplit('\\').next().unwrap_or_default().to_string();
    if !requested.eq_ignore_ascii_case(share) && !requested.eq_ignore_ascii_case("IPC$") {
        tracing::warn!("smb: rejected tree connect to {requested:?}");
        return Err(STATUS_BAD_NETWORK_NAME);
    }

    let tree_id = 1u32;
    conn.tree_ids.insert(tree_id, requested);

    let mut reply = *header;
    reply.tree_id = tree_id;
    let mut w = Writer::new();
    reply.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(16);
    w.u8(0x01); // SMB2_SHARE_TYPE_DISK
    w.u8(0);
    w.u32(0); // share flags: manual caching, no DFS
    w.u32(0); // capabilities
    // Maximal access. Claiming write on a share that refuses it makes a client
    // present the mount as writable and only discover otherwise when a save
    // fails, which is the worst moment to find out.
    w.u32(if conn.volume.writable() { FULL_ACCESS } else { READ_ACCESS });
    Ok(w.buf)
}

// ---- helpers shared with the info module ----

/// Handlers return either a response or an NTSTATUS to report.
pub type Status<T> = std::result::Result<T, u32>;

pub fn error_response(header: &Header, status: u32) -> Vec<u8> {
    let mut w = Writer::new();
    header.write_response(&mut w, status, header.credits.max(1));
    // SMB2 ERROR response: structure size 9, then a single reserved byte.
    w.u16(9);
    w.u16(0);
    w.u32(0);
    w.u8(0);
    w.buf
}

pub fn simple_response(header: &Header, _size: u16, body: impl FnOnce(&mut Writer)) -> Vec<u8> {
    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    body(&mut w);
    w.buf
}

/// Stable identity for this one-volume SMB server. Clients cache it across
/// reconnects, so process-random bytes make a restarted share look unrelated.
fn server_guid(filesystem_id: u64) -> [u8; 16] {
    let digest = blake3::hash(&filesystem_id.to_le_bytes());
    let mut guid = [0u8; 16];
    guid.copy_from_slice(&digest.as_bytes()[..16]);
    guid
}

/// Map engine errors onto the NTSTATUS values Windows expects.
pub fn status_of(e: FsError) -> u32 {
    match e {
        FsError::NotFound => STATUS_OBJECT_NAME_NOT_FOUND,
        FsError::Exists => STATUS_OBJECT_NAME_COLLISION,
        FsError::NotDir => STATUS_NOT_A_DIRECTORY,
        FsError::IsDir => STATUS_FILE_IS_A_DIRECTORY,
        FsError::NotEmpty => STATUS_DIRECTORY_NOT_EMPTY,
        FsError::Inval => STATUS_INVALID_PARAMETER,
        FsError::NoSpace => STATUS_CANNOT_DELETE,
        FsError::ReadOnly => STATUS_MEDIA_WRITE_PROTECTED,
        other => {
            tracing::error!("smb: {other}");
            STATUS_INVALID_PARAMETER
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::server_guid;

    #[test]
    fn server_guid_is_stable_and_volume_specific() {
        assert_eq!(server_guid(42), server_guid(42));
        assert_ne!(server_guid(42), server_guid(43));
        assert_ne!(server_guid(42), [0; 16]);
    }
}

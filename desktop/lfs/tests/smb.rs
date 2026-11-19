//! Protocol-level tests for the SMB front end.
//!
//! These drive a real socket through the whole handshake — negotiate,
//! NTLMv2 authenticate, tree connect — and then exercise file operations, so
//! the wire format is checked without needing a mounted client.
//!
//! The NTLM maths is deliberately reimplemented here rather than reused from
//! the server, so a mistake in the server's derivation cannot cancel out.

use std::path::PathBuf;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use md4::Md4;
use md5::{Digest, Md5};
use lfs::fs::{FileSystem, Volume};
use lfs::server::smb::{serve_smb, Credentials};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

type HmacMd5 = Hmac<Md5>;

const HEADER_LEN: usize = 64;
const STATUS_SUCCESS: u32 = 0x0000_0000;
const STATUS_MORE_PROCESSING_REQUIRED: u32 = 0xC000_0016;
const STATUS_LOGON_FAILURE: u32 = 0xC000_006D;
const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lfs-smb-{tag}-{n}"));
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        std::fs::create_dir_all(dir.join("state")).unwrap();
        Env { dir }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Start a server on an ephemeral port and return a connected client.
async fn start(env: &Env) -> Client {
    let volume = Volume::open(
        env.dir.join("backend").to_str().unwrap(),
        &env.dir.join("state"),
    )
    .await
    .unwrap();

    let creds = Credentials {
        user: "alice".into(),
        password: "hunter2".into(),
        domain: "LFS".into(),
    };
    let fs: Arc<dyn FileSystem> = volume;
    let (port, run) = serve_smb(fs, "127.0.0.1:0", "share".into(), creds).await.unwrap();
    tokio::spawn(run);

    let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    Client { socket, message_id: 0, session_id: 0, tree_id: 0 }
}

struct Client {
    socket: TcpStream,
    message_id: u64,
    session_id: u64,
    tree_id: u32,
}

struct Response {
    status: u32,
    body: Vec<u8>,
}

impl Client {
    fn header(&mut self, command: u16) -> Vec<u8> {
        let mut h = Vec::with_capacity(HEADER_LEN);
        h.extend_from_slice(&[0xFE, b'S', b'M', b'B']);
        h.extend_from_slice(&64u16.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes()); // credit charge
        h.extend_from_slice(&0u32.to_le_bytes()); // status
        h.extend_from_slice(&command.to_le_bytes());
        h.extend_from_slice(&31u16.to_le_bytes()); // credits requested
        h.extend_from_slice(&0u32.to_le_bytes()); // flags
        h.extend_from_slice(&0u32.to_le_bytes()); // next command
        h.extend_from_slice(&self.message_id.to_le_bytes());
        h.extend_from_slice(&0u32.to_le_bytes()); // reserved
        h.extend_from_slice(&self.tree_id.to_le_bytes());
        h.extend_from_slice(&self.session_id.to_le_bytes());
        h.extend_from_slice(&[0u8; 16]); // signature
        self.message_id += 1;
        h
    }

    async fn send(&mut self, packet: &[u8]) -> Response {
        let mut framed = (packet.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(packet);
        self.socket.write_all(&framed).await.unwrap();

        let mut prefix = [0u8; 4];
        self.socket.read_exact(&mut prefix).await.unwrap();
        let len = u32::from_be_bytes(prefix) as usize & 0x00FF_FFFF;
        let mut buf = vec![0u8; len];
        self.socket.read_exact(&mut buf).await.unwrap();

        let status = u32::from_le_bytes(buf[8..12].try_into().unwrap());
        Response { status, body: buf }
    }

    async fn negotiate(&mut self) -> u16 {
        let mut p = self.header(0x0000);
        p.extend_from_slice(&36u16.to_le_bytes()); // structure size
        p.extend_from_slice(&2u16.to_le_bytes()); // dialect count
        p.extend_from_slice(&1u16.to_le_bytes()); // security mode: signing enabled
        p.extend_from_slice(&0u16.to_le_bytes()); // reserved
        p.extend_from_slice(&0u32.to_le_bytes()); // capabilities
        p.extend_from_slice(&[0u8; 16]); // client guid
        p.extend_from_slice(&[0u8; 8]); // negotiate context info
        p.extend_from_slice(&0x0210u16.to_le_bytes());
        p.extend_from_slice(&0x0302u16.to_le_bytes());

        let r = self.send(&p).await;
        assert_eq!(r.status, STATUS_SUCCESS, "negotiate must succeed");
        u16::from_le_bytes(r.body[HEADER_LEN + 4..HEADER_LEN + 6].try_into().unwrap())
    }

    /// Run the two-step NTLM exchange. Returns the final status so tests can
    /// assert on rejection as well as success.
    async fn authenticate(&mut self, user: &str, password: &str) -> u32 {
        // Step one: a bare NEGOTIATE token is enough to draw out the challenge.
        let mut type1 = b"NTLMSSP\0".to_vec();
        type1.extend_from_slice(&1u32.to_le_bytes());
        type1.extend_from_slice(&0u32.to_le_bytes()); // flags
        type1.extend_from_slice(&[0u8; 16]); // domain and workstation fields

        let r = self.session_setup(&type1).await;
        assert_eq!(
            r.status, STATUS_MORE_PROCESSING_REQUIRED,
            "the first session setup must ask the client to continue"
        );
        self.session_id = u64::from_le_bytes(r.body[40..48].try_into().unwrap());

        let token = find_ntlm(&r.body).expect("challenge must contain an NTLM token");
        assert_eq!(u32::from_le_bytes(token[8..12].try_into().unwrap()), 2);
        let mut server_challenge = [0u8; 8];
        server_challenge.copy_from_slice(&token[24..32]);

        let type3 = build_authenticate(user, "LFS", password, &server_challenge);
        self.session_setup(&type3).await.status
    }

    async fn session_setup(&mut self, token: &[u8]) -> Response {
        let mut p = self.header(0x0001);
        p.extend_from_slice(&25u16.to_le_bytes());
        p.push(0); // flags
        p.push(1); // security mode
        p.extend_from_slice(&0u32.to_le_bytes()); // capabilities
        p.extend_from_slice(&0u32.to_le_bytes()); // channel
        p.extend_from_slice(&((HEADER_LEN + 24) as u16).to_le_bytes());
        p.extend_from_slice(&(token.len() as u16).to_le_bytes());
        p.extend_from_slice(&0u64.to_le_bytes()); // previous session id
        p.extend_from_slice(token);
        self.send(&p).await
    }

    async fn tree_connect(&mut self, share: &str) -> u32 {
        let path = utf16(&format!("\\\\127.0.0.1\\{share}"));
        let mut p = self.header(0x0003);
        p.extend_from_slice(&9u16.to_le_bytes());
        p.extend_from_slice(&0u16.to_le_bytes()); // flags
        p.extend_from_slice(&((HEADER_LEN + 8) as u16).to_le_bytes());
        p.extend_from_slice(&(path.len() as u16).to_le_bytes());
        p.extend_from_slice(&path);

        let r = self.send(&p).await;
        if r.status == STATUS_SUCCESS {
            self.tree_id = u32::from_le_bytes(r.body[36..40].try_into().unwrap());
        }
        r.status
    }

    /// CREATE, returning the file id on success.
    async fn create(&mut self, path: &str, disposition: u32, options: u32) -> (u32, u64) {
        let name = utf16(path);
        let mut p = self.header(0x0005);
        p.extend_from_slice(&57u16.to_le_bytes());
        p.push(0); // security flags
        p.push(0); // oplock
        p.extend_from_slice(&2u32.to_le_bytes()); // impersonation
        p.extend_from_slice(&[0u8; 16]); // create flags, reserved
        p.extend_from_slice(&0x0012_019Fu32.to_le_bytes()); // desired access
        p.extend_from_slice(&0x80u32.to_le_bytes()); // file attributes
        p.extend_from_slice(&7u32.to_le_bytes()); // share access
        p.extend_from_slice(&disposition.to_le_bytes());
        p.extend_from_slice(&options.to_le_bytes());
        p.extend_from_slice(&((HEADER_LEN + 56) as u16).to_le_bytes());
        p.extend_from_slice(&(name.len() as u16).to_le_bytes());
        p.extend_from_slice(&0u32.to_le_bytes()); // create contexts offset
        p.extend_from_slice(&0u32.to_le_bytes()); // create contexts length
        p.extend_from_slice(&name);

        let r = self.send(&p).await;
        if r.status != STATUS_SUCCESS {
            return (r.status, 0);
        }
        let id = u64::from_le_bytes(r.body[HEADER_LEN + 64..HEADER_LEN + 72].try_into().unwrap());
        (r.status, id)
    }

    async fn write(&mut self, id: u64, offset: u64, data: &[u8]) -> u32 {
        let mut p = self.header(0x0009);
        p.extend_from_slice(&49u16.to_le_bytes());
        p.extend_from_slice(&((HEADER_LEN + 48) as u16).to_le_bytes());
        p.extend_from_slice(&(data.len() as u32).to_le_bytes());
        p.extend_from_slice(&offset.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&0u32.to_le_bytes()); // channel
        p.extend_from_slice(&0u32.to_le_bytes()); // remaining
        p.extend_from_slice(&0u16.to_le_bytes());
        p.extend_from_slice(&0u16.to_le_bytes());
        p.extend_from_slice(&0u32.to_le_bytes()); // flags
        p.extend_from_slice(data);
        self.send(&p).await.status
    }

    async fn read(&mut self, id: u64, offset: u64, length: u32) -> (u32, Vec<u8>) {
        let mut p = self.header(0x0008);
        p.extend_from_slice(&49u16.to_le_bytes());
        p.push(0); // padding
        p.push(0); // flags
        p.extend_from_slice(&length.to_le_bytes());
        p.extend_from_slice(&offset.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&0u32.to_le_bytes()); // minimum count
        p.extend_from_slice(&0u32.to_le_bytes()); // channel
        p.extend_from_slice(&0u32.to_le_bytes()); // remaining
        p.extend_from_slice(&0u16.to_le_bytes());
        p.extend_from_slice(&0u16.to_le_bytes());
        p.push(0);

        let r = self.send(&p).await;
        if r.status != STATUS_SUCCESS {
            return (r.status, Vec::new());
        }
        let data_offset = r.body[HEADER_LEN + 2] as usize;
        let data_len = u32::from_le_bytes(
            r.body[HEADER_LEN + 4..HEADER_LEN + 8].try_into().unwrap(),
        ) as usize;
        (r.status, r.body[data_offset..data_offset + data_len].to_vec())
    }

    async fn close(&mut self, id: u64) -> u32 {
        let mut p = self.header(0x0006);
        p.extend_from_slice(&24u16.to_le_bytes());
        p.extend_from_slice(&0u16.to_le_bytes()); // flags
        p.extend_from_slice(&0u32.to_le_bytes()); // reserved
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        self.send(&p).await.status
    }

    /// QUERY_DIRECTORY, returning the names found.
    async fn list(&mut self, id: u64, pattern: &str) -> (u32, Vec<String>) {
        let pat = utf16(pattern);
        let mut p = self.header(0x000E);
        p.extend_from_slice(&33u16.to_le_bytes());
        p.push(37); // FileIdBothDirectoryInformation
        p.push(0x01); // restart scans
        p.extend_from_slice(&0u32.to_le_bytes()); // file index
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&((HEADER_LEN + 32) as u16).to_le_bytes());
        p.extend_from_slice(&(pat.len() as u16).to_le_bytes());
        p.extend_from_slice(&65536u32.to_le_bytes()); // output buffer length
        p.extend_from_slice(&pat);

        let r = self.send(&p).await;
        if r.status != STATUS_SUCCESS {
            return (r.status, Vec::new());
        }
        let offset = u16::from_le_bytes(
            r.body[HEADER_LEN + 2..HEADER_LEN + 4].try_into().unwrap(),
        ) as usize;
        let len = u32::from_le_bytes(
            r.body[HEADER_LEN + 4..HEADER_LEN + 8].try_into().unwrap(),
        ) as usize;
        (r.status, parse_dir_entries(&r.body[offset..offset + len]))
    }
}

/// Walk a FileIdBothDirectoryInformation chain.
fn parse_dir_entries(buf: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let mut at = 0usize;
    loop {
        if at + 104 > buf.len() {
            break;
        }
        let next = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as usize;
        let name_len =
            u32::from_le_bytes(buf[at + 60..at + 64].try_into().unwrap()) as usize;
        let name_at = at + 104;
        if name_at + name_len <= buf.len() {
            names.push(from_utf16(&buf[name_at..name_at + name_len]));
        }
        if next == 0 {
            break;
        }
        at += next;
    }
    names
}

// ---- helpers ----

fn utf16(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

fn from_utf16(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn find_ntlm(buf: &[u8]) -> Option<&[u8]> {
    buf.windows(8)
        .position(|w| w == b"NTLMSSP\0")
        .map(|at| &buf[at..])
}

fn hmac_md5(key: &[u8], data: &[u8]) -> [u8; 16] {
    let mut mac = <HmacMd5 as Mac>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Build an NTLM AUTHENTICATE message, computing NTLMv2 independently of the
/// server's implementation.
fn build_authenticate(user: &str, domain: &str, password: &str, challenge: &[u8; 8]) -> Vec<u8> {
    let nt_hash = Md4::digest(utf16(password));
    let mut identity = utf16(&user.to_uppercase());
    identity.extend_from_slice(&utf16(domain));
    let key = hmac_md5(&nt_hash, &identity);

    // A minimal but well-formed NTLMv2 client blob.
    let mut blob = vec![0x01, 0x01, 0x00, 0x00];
    blob.extend_from_slice(&0u32.to_le_bytes());
    blob.extend_from_slice(&0u64.to_le_bytes()); // timestamp
    blob.extend_from_slice(&[0x11; 8]); // client challenge
    blob.extend_from_slice(&0u32.to_le_bytes());
    blob.extend_from_slice(&0u32.to_le_bytes()); // AV pair terminator

    let mut to_mac = challenge.to_vec();
    to_mac.extend_from_slice(&blob);
    let proof = hmac_md5(&key, &to_mac);

    let mut nt_response = proof.to_vec();
    nt_response.extend_from_slice(&blob);
    let domain_u = utf16(domain);
    let user_u = utf16(user);

    // 8 signature + 4 type + 6 descriptors + 4 flags + 8 version.
    let header = 72usize;
    let nt_off = header;
    let dom_off = nt_off + nt_response.len();
    let user_off = dom_off + domain_u.len();

    let mut m = b"NTLMSSP\0".to_vec();
    m.extend_from_slice(&3u32.to_le_bytes());
    let fields = |m: &mut Vec<u8>, len: usize, off: usize| {
        m.extend_from_slice(&(len as u16).to_le_bytes());
        m.extend_from_slice(&(len as u16).to_le_bytes());
        m.extend_from_slice(&(off as u32).to_le_bytes());
    };
    fields(&mut m, 0, nt_off); // LM response
    fields(&mut m, nt_response.len(), nt_off);
    fields(&mut m, domain_u.len(), dom_off);
    fields(&mut m, user_u.len(), user_off);
    fields(&mut m, 0, user_off); // workstation
    fields(&mut m, 0, user_off); // encrypted session key
    m.extend_from_slice(&0u32.to_le_bytes()); // flags: no key exchange
    m.extend_from_slice(&[0u8; 8]); // version
    assert_eq!(m.len(), header);
    m.extend_from_slice(&nt_response);
    m.extend_from_slice(&domain_u);
    m.extend_from_slice(&user_u);
    m
}

// ---- tests ----

#[tokio::test]
async fn negotiates_an_smb2_dialect() {
    let env = Env::new("negotiate");
    let mut c = start(&env).await;
    let dialect = c.negotiate().await;
    assert!(
        dialect == 0x0210 || dialect == 0x0302,
        "server picked an unexpected dialect {dialect:#06x}"
    );
}

#[tokio::test]
async fn authenticates_with_the_right_password() {
    let env = Env::new("auth-ok");
    let mut c = start(&env).await;
    c.negotiate().await;
    assert_eq!(c.authenticate("alice", "hunter2").await, STATUS_SUCCESS);
}

#[tokio::test]
async fn rejects_the_wrong_password() {
    let env = Env::new("auth-bad");
    let mut c = start(&env).await;
    c.negotiate().await;
    assert_eq!(c.authenticate("alice", "wrong").await, STATUS_LOGON_FAILURE);
}

#[tokio::test]
async fn rejects_an_unknown_share() {
    let env = Env::new("share");
    let mut c = start(&env).await;
    c.negotiate().await;
    c.authenticate("alice", "hunter2").await;
    assert_ne!(c.tree_connect("nosuchshare").await, STATUS_SUCCESS);
    assert_eq!(c.tree_connect("share").await, STATUS_SUCCESS);
}

#[tokio::test]
async fn creates_writes_and_reads_a_file() {
    let env = Env::new("io");
    let mut c = start(&env).await;
    c.negotiate().await;
    c.authenticate("alice", "hunter2").await;
    c.tree_connect("share").await;

    // FILE_CREATE, FILE_NON_DIRECTORY_FILE
    let (status, id) = c.create("hello.txt", 2, 0x40).await;
    assert_eq!(status, STATUS_SUCCESS);
    assert_eq!(c.write(id, 0, b"hello smb").await, STATUS_SUCCESS);
    assert_eq!(c.close(id).await, STATUS_SUCCESS);

    // FILE_OPEN
    let (status, id) = c.create("hello.txt", 1, 0x40).await;
    assert_eq!(status, STATUS_SUCCESS);
    let (status, data) = c.read(id, 0, 1024).await;
    assert_eq!(status, STATUS_SUCCESS);
    assert_eq!(data, b"hello smb");
}

#[tokio::test]
async fn opening_a_missing_file_reports_not_found() {
    let env = Env::new("missing");
    let mut c = start(&env).await;
    c.negotiate().await;
    c.authenticate("alice", "hunter2").await;
    c.tree_connect("share").await;

    let (status, _) = c.create("nope.txt", 1, 0x40).await;
    assert_eq!(status, STATUS_OBJECT_NAME_NOT_FOUND);
}

#[tokio::test]
async fn writes_spanning_chunks_read_back_intact() {
    let env = Env::new("big");
    let mut c = start(&env).await;
    c.negotiate().await;
    c.authenticate("alice", "hunter2").await;
    c.tree_connect("share").await;

    let (_, id) = c.create("big.bin", 2, 0x40).await;
    // Larger than the engine's 256 KiB chunk, and not chunk-aligned.
    let payload: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    for (n, piece) in payload.chunks(65536).enumerate() {
        assert_eq!(c.write(id, (n * 65536) as u64, piece).await, STATUS_SUCCESS);
    }
    c.close(id).await;

    let (_, id) = c.create("big.bin", 1, 0x40).await;
    let mut got = Vec::new();
    while got.len() < payload.len() {
        let (status, chunk) = c.read(id, got.len() as u64, 65536).await;
        assert_eq!(status, STATUS_SUCCESS);
        got.extend_from_slice(&chunk);
    }
    assert_eq!(got, payload, "data must survive the chunking round trip");
}

#[tokio::test]
async fn directory_listing_honours_the_search_pattern() {
    let env = Env::new("listing");
    let mut c = start(&env).await;
    c.negotiate().await;
    c.authenticate("alice", "hunter2").await;
    c.tree_connect("share").await;

    for name in ["one.txt", "two.txt", "three.md"] {
        let (_, id) = c.create(name, 2, 0x40).await;
        c.close(id).await;
    }

    // FILE_DIRECTORY_FILE on the share root
    let (status, dir) = c.create("", 1, 0x01).await;
    assert_eq!(status, STATUS_SUCCESS);

    let (_, all) = c.list(dir, "*").await;
    assert!(all.contains(&"one.txt".to_string()));
    assert!(all.contains(&".".to_string()), "clients expect . and ..");
    assert!(all.contains(&"..".to_string()));

    let (_, txt) = c.list(dir, "*.txt").await;
    assert_eq!(txt.len(), 2, "the pattern must filter: got {txt:?}");

    // A single-name pattern is how clients implement stat.
    let (_, one) = c.list(dir, "one.txt").await;
    assert_eq!(one, vec!["one.txt".to_string()]);
}

#[tokio::test]
async fn unauthenticated_requests_are_refused() {
    let env = Env::new("noauth");
    let mut c = start(&env).await;
    c.negotiate().await;
    // Skip authentication entirely and try to use the share.
    assert_ne!(c.tree_connect("share").await, STATUS_SUCCESS);
}

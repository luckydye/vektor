//! Little-endian cursor helpers and SMB2 header framing.
//!
//! SMB2 is a fixed-header + variable-body protocol where nearly every
//! structure locates its variable parts by an offset measured from the start
//! of the *packet header*, not from the start of the structure. Getting that
//! base wrong is the single most common way to produce a response Windows
//! silently rejects, so offsets are computed explicitly everywhere.

/// SMB2 protocol id, `\xFESMB`.
pub const SMB2_MAGIC: [u8; 4] = [0xFE, b'S', b'M', b'B'];
pub const HEADER_LEN: usize = 64;

// Commands.
pub const SMB2_NEGOTIATE: u16 = 0x0000;
pub const SMB2_SESSION_SETUP: u16 = 0x0001;
pub const SMB2_LOGOFF: u16 = 0x0002;
pub const SMB2_TREE_CONNECT: u16 = 0x0003;
pub const SMB2_TREE_DISCONNECT: u16 = 0x0004;
pub const SMB2_CREATE: u16 = 0x0005;
pub const SMB2_CLOSE: u16 = 0x0006;
pub const SMB2_FLUSH: u16 = 0x0007;
pub const SMB2_READ: u16 = 0x0008;
pub const SMB2_WRITE: u16 = 0x0009;
pub const SMB2_LOCK: u16 = 0x000A;
pub const SMB2_IOCTL: u16 = 0x000B;
pub const SMB2_CANCEL: u16 = 0x000C;
pub const SMB2_ECHO: u16 = 0x000D;
pub const SMB2_QUERY_DIRECTORY: u16 = 0x000E;
pub const SMB2_CHANGE_NOTIFY: u16 = 0x000F;
pub const SMB2_QUERY_INFO: u16 = 0x0010;
pub const SMB2_SET_INFO: u16 = 0x0011;

// Header flags.
pub const SMB2_FLAGS_SERVER_TO_REDIR: u32 = 0x0000_0001;
pub const SMB2_FLAGS_SIGNED: u32 = 0x0000_0008;

// Status codes (NTSTATUS).
pub const STATUS_SUCCESS: u32 = 0x0000_0000;
pub const STATUS_PENDING: u32 = 0x0000_0103;
pub const STATUS_NO_MORE_FILES: u32 = 0x8000_0006;
pub const STATUS_NOT_IMPLEMENTED: u32 = 0xC000_0002;
pub const STATUS_INVALID_PARAMETER: u32 = 0xC000_000D;
pub const STATUS_NO_SUCH_FILE: u32 = 0xC000_000F;
pub const STATUS_END_OF_FILE: u32 = 0xC000_0011;
pub const STATUS_MORE_PROCESSING_REQUIRED: u32 = 0xC000_0016;
pub const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
pub const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;
pub const STATUS_OBJECT_NAME_COLLISION: u32 = 0xC000_0035;
pub const STATUS_OBJECT_PATH_NOT_FOUND: u32 = 0xC000_003A;
pub const STATUS_LOGON_FAILURE: u32 = 0xC000_006D;
pub const STATUS_DIRECTORY_NOT_EMPTY: u32 = 0xC000_0101;
pub const STATUS_FILE_IS_A_DIRECTORY: u32 = 0xC000_00BA;
pub const STATUS_NOT_A_DIRECTORY: u32 = 0xC000_0103;
pub const STATUS_NOT_SUPPORTED: u32 = 0xC000_00BB;
pub const STATUS_USER_SESSION_DELETED: u32 = 0xC000_00DF;
pub const STATUS_NETWORK_NAME_DELETED: u32 = 0xC000_00C9;
pub const STATUS_BAD_NETWORK_NAME: u32 = 0xC000_00CC;
pub const STATUS_INFO_LENGTH_MISMATCH: u32 = 0xC000_0004;
pub const STATUS_BUFFER_OVERFLOW: u32 = 0x8000_0005;
pub const STATUS_INVALID_INFO_CLASS: u32 = 0xC000_0003;
pub const STATUS_CANNOT_DELETE: u32 = 0xC000_0121;
pub const STATUS_MEDIA_WRITE_PROTECTED: u32 = 0xC000_00A2;

/// Reading side of a request buffer.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }

    pub fn at(buf: &'a [u8], pos: usize) -> Reader<'a> {
        Reader { buf, pos }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn skip(&mut self, n: usize) {
        self.pos = (self.pos + n).min(self.buf.len());
    }

    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    pub fn u8(&mut self) -> u8 {
        let v = self.buf.get(self.pos).copied().unwrap_or(0);
        self.pos += 1;
        v
    }

    pub fn u16(&mut self) -> u16 {
        let v = self.slice(2);
        u16::from_le_bytes([v[0], v[1]])
    }

    pub fn u32(&mut self) -> u32 {
        let v = self.slice(4);
        u32::from_le_bytes([v[0], v[1], v[2], v[3]])
    }

    pub fn u64(&mut self) -> u64 {
        let v = self.slice(8);
        u64::from_le_bytes(v[0..8].try_into().unwrap())
    }

    /// Read `n` bytes, zero-padded if the buffer is short. Truncated requests
    /// then decode to harmless zeroes instead of panicking.
    pub fn slice(&mut self, n: usize) -> Vec<u8> {
        let end = (self.pos + n).min(self.buf.len());
        let mut out = self.buf[self.pos.min(end)..end].to_vec();
        out.resize(n, 0);
        self.pos += n;
        out
    }

    /// Borrow a range measured from the start of the whole packet.
    pub fn view(&self, offset: usize, len: usize) -> &'a [u8] {
        let start = offset.min(self.buf.len());
        let end = (offset + len).min(self.buf.len());
        &self.buf[start..end]
    }
}

/// Writing side of a response buffer.
#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Writer {
        Writer { buf: Vec::with_capacity(256) }
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    pub fn zeros(&mut self, n: usize) -> &mut Self {
        self.buf.resize(self.buf.len() + n, 0);
        self
    }

    /// Pad to an 8-byte boundary, which several SMB2 structures require.
    pub fn align8(&mut self) -> &mut Self {
        while !self.buf.len().is_multiple_of(8) {
            self.buf.push(0);
        }
        self
    }

    pub fn patch_u16(&mut self, at: usize, v: u16) {
        self.buf[at..at + 2].copy_from_slice(&v.to_le_bytes());
    }

    pub fn patch_u32(&mut self, at: usize, v: u32) {
        self.buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
}

/// The 64-byte SMB2 packet header.
#[derive(Debug, Clone, Copy, Default)]
pub struct Header {
    pub credit_charge: u16,
    pub status: u32,
    pub command: u16,
    pub credits: u16,
    pub flags: u32,
    pub next_command: u32,
    pub message_id: u64,
    pub tree_id: u32,
    pub session_id: u64,
}

impl Header {
    pub fn parse(buf: &[u8]) -> Option<Header> {
        if buf.len() < HEADER_LEN || buf[0..4] != SMB2_MAGIC {
            return None;
        }
        let mut r = Reader::at(buf, 4);
        r.skip(2); // structure size, always 64
        let credit_charge = r.u16();
        let status = r.u32();
        let command = r.u16();
        let credits = r.u16();
        let flags = r.u32();
        let next_command = r.u32();
        let message_id = r.u64();
        r.skip(4); // reserved / process id
        let tree_id = r.u32();
        let session_id = r.u64();
        Some(Header {
            credit_charge,
            status,
            command,
            credits,
            flags,
            next_command,
            message_id,
            tree_id,
            session_id,
        })
    }

    /// Serialise as a response header, with the signature left zeroed for the
    /// signing pass to fill in.
    pub fn write_response(&self, w: &mut Writer, status: u32, credits: u16) {
        w.bytes(&SMB2_MAGIC);
        w.u16(HEADER_LEN as u16);
        w.u16(self.credit_charge.max(1));
        w.u32(status);
        w.u16(self.command);
        w.u16(credits);
        w.u32(self.flags | SMB2_FLAGS_SERVER_TO_REDIR);
        w.u32(0); // next command; compounding is not used in responses here
        w.u64(self.message_id);
        w.u32(0); // reserved
        w.u32(self.tree_id);
        w.u64(self.session_id);
        w.zeros(16); // signature
    }
}

/// Windows FILETIME: 100 ns ticks since 1601-01-01.
pub fn filetime(secs: u64, nanos: u32) -> u64 {
    const EPOCH_DIFF: u64 = 11_644_473_600;
    (secs + EPOCH_DIFF) * 10_000_000 + (nanos as u64) / 100
}

/// Inverse of [`filetime`]. Zero and the "no change" sentinel both mean
/// "leave the timestamp alone", which the caller distinguishes.
pub fn from_filetime(ft: u64) -> Option<(u64, u32)> {
    const EPOCH_DIFF: u64 = 11_644_473_600;
    if ft == 0 || ft == u64::MAX {
        return None;
    }
    let secs = ft / 10_000_000;
    if secs < EPOCH_DIFF {
        return None;
    }
    Some((secs - EPOCH_DIFF, ((ft % 10_000_000) * 100) as u32))
}

/// SMB paths are UTF-16LE and use backslashes.
pub fn utf16_to_string(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

pub fn string_to_utf16(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 2);
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_round_trips() {
        let (s, n) = from_filetime(filetime(1_700_000_000, 500_000_000)).unwrap();
        assert_eq!(s, 1_700_000_000);
        assert_eq!(n / 100, 500_000_000 / 100);
    }

    #[test]
    fn sentinel_filetimes_mean_no_change() {
        assert!(from_filetime(0).is_none());
        assert!(from_filetime(u64::MAX).is_none());
    }

    #[test]
    fn utf16_round_trips() {
        assert_eq!(utf16_to_string(&string_to_utf16("dir\\file.txt")), "dir\\file.txt");
    }

    #[test]
    fn short_reads_pad_instead_of_panicking() {
        let mut r = Reader::new(&[1, 2]);
        assert_eq!(r.u32(), u32::from_le_bytes([1, 2, 0, 0]));
    }
}

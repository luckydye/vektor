//! NTLMv2 authentication and the minimal SPNEGO wrapping around it.
//!
//! Windows 10/11 refuse guest fallback by default, so a usable SMB server has
//! to actually verify a password. NTLMv2 is the mechanism every Windows and
//! macOS client will negotiate without a domain controller.
//!
//! Only the parts SMB needs are implemented: enough DER to emit the SPNEGO
//! tokens, and enough NTLM to challenge, verify, and derive the session key
//! that packet signing then uses.

use hmac::{Hmac, Mac};
use md4::Md4;
use md5::{Digest, Md5};

use super::wire::{string_to_utf16, utf16_to_string};

type HmacMd5 = Hmac<Md5>;

const NTLMSSP_SIGNATURE: &[u8; 8] = b"NTLMSSP\0";
const MSG_NEGOTIATE: u32 = 1;
const MSG_CHALLENGE: u32 = 2;
const MSG_AUTHENTICATE: u32 = 3;

const NEGOTIATE_UNICODE: u32 = 0x0000_0001;
const NEGOTIATE_SIGN: u32 = 0x0000_0010;
const NEGOTIATE_NTLM: u32 = 0x0000_0200;
const NEGOTIATE_ALWAYS_SIGN: u32 = 0x0000_8000;
const NEGOTIATE_EXTENDED_SESSIONSECURITY: u32 = 0x0008_0000;
const NEGOTIATE_TARGET_INFO: u32 = 0x0080_0000;
const NEGOTIATE_128: u32 = 0x2000_0000;
const NEGOTIATE_KEY_EXCH: u32 = 0x4000_0000;
const NEGOTIATE_56: u32 = 0x8000_0000;
const REQUEST_TARGET: u32 = 0x0000_0004;

/// SPNEGO OID 1.3.6.1.5.5.2.
const OID_SPNEGO: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x02];
/// NTLMSSP OID 1.3.6.1.4.1.311.2.2.10.
const OID_NTLMSSP: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a];

/// The credentials a share is protected with.
#[derive(Clone)]
pub struct Credentials {
    pub user: String,
    pub password: String,
    pub domain: String,
}

/// Result of a completed NTLM exchange.
pub struct Authenticated {
    pub user: String,
    /// First 16 bytes are the SMB2 session key.
    pub session_key: [u8; 16],
}

// ---- minimal DER ----

fn der_len(len: usize) -> Vec<u8> {
    if len < 0x80 {
        vec![len as u8]
    } else if len <= 0xFF {
        vec![0x81, len as u8]
    } else {
        vec![0x82, (len >> 8) as u8, (len & 0xFF) as u8]
    }
}

fn der(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&der_len(body.len()));
    out.extend_from_slice(body);
    out
}

/// The SPNEGO `NegTokenInit` advertised in the NEGOTIATE response: "I speak
/// NTLMSSP". Clients use this to decide what to send in SESSION_SETUP.
pub fn spnego_neg_token_init() -> Vec<u8> {
    let mech_list = der(0x30, &der(0x06, OID_NTLMSSP));
    let mech_types = der(0xA0, &mech_list);
    let neg_token_init = der(0x30, &mech_types);
    let inner = der(0xA0, &neg_token_init);

    let mut body = der(0x06, OID_SPNEGO);
    body.extend_from_slice(&inner);
    der(0x60, &body)
}

/// `NegTokenResp` carrying a server token, with `accept-incomplete` state.
pub fn spnego_neg_token_resp(token: &[u8]) -> Vec<u8> {
    let neg_state = der(0xA0, &der(0x0A, &[1])); // accept-incomplete
    let supported = der(0xA1, &der(0x06, OID_NTLMSSP));
    let response = der(0xA2, &der(0x04, token));

    let mut seq = neg_state;
    seq.extend_from_slice(&supported);
    seq.extend_from_slice(&response);
    der(0xA1, &der(0x30, &seq))
}

/// `NegTokenResp` with `accept-completed` and no token: authentication done.
pub fn spnego_accept_completed() -> Vec<u8> {
    der(0xA1, &der(0x30, &der(0xA0, &der(0x0A, &[0]))))
}

/// Find the NTLMSSP message inside a security blob, whether it arrived raw or
/// wrapped in SPNEGO DER.
///
/// NTLM messages locate their fields by explicit offsets from the start of the
/// message, so any DER bytes trailing the token are simply never read. That
/// makes scanning for the signature both simpler and more robust than a full
/// ASN.1 parser across the many shapes clients actually send.
pub fn find_ntlm_message(blob: &[u8]) -> Option<&[u8]> {
    blob.windows(8)
        .position(|w| w == NTLMSSP_SIGNATURE)
        .map(|at| &blob[at..])
}

fn message_type(msg: &[u8]) -> Option<u32> {
    if msg.len() < 12 || &msg[0..8] != NTLMSSP_SIGNATURE {
        return None;
    }
    Some(u32::from_le_bytes(msg[8..12].try_into().unwrap()))
}

pub fn is_negotiate(msg: &[u8]) -> bool {
    message_type(msg) == Some(MSG_NEGOTIATE)
}

pub fn is_authenticate(msg: &[u8]) -> bool {
    message_type(msg) == Some(MSG_AUTHENTICATE)
}

/// Read a (len, maxlen, offset) field descriptor and return the bytes it names.
fn field(msg: &[u8], at: usize) -> &[u8] {
    if msg.len() < at + 8 {
        return &[];
    }
    let len = u16::from_le_bytes(msg[at..at + 2].try_into().unwrap()) as usize;
    let off = u32::from_le_bytes(msg[at + 4..at + 8].try_into().unwrap()) as usize;
    if off > msg.len() {
        return &[];
    }
    &msg[off..(off + len).min(msg.len())]
}

fn av_pair(kind: u16, value: &[u8]) -> Vec<u8> {
    let mut out = kind.to_le_bytes().to_vec();
    out.extend_from_slice(&(value.len() as u16).to_le_bytes());
    out.extend_from_slice(value);
    out
}

/// Build the NTLM CHALLENGE (type 2) message.
pub fn challenge(server_challenge: &[u8; 8], netbios_name: &str, domain: &str) -> Vec<u8> {
    let target = string_to_utf16(domain);

    let mut info = Vec::new();
    info.extend_from_slice(&av_pair(2, &string_to_utf16(domain))); // NetBIOS domain
    info.extend_from_slice(&av_pair(1, &string_to_utf16(netbios_name))); // NetBIOS computer
    info.extend_from_slice(&av_pair(4, &string_to_utf16(&domain.to_lowercase()))); // DNS domain
    info.extend_from_slice(&av_pair(3, &string_to_utf16(&netbios_name.to_lowercase()))); // DNS computer
    info.extend_from_slice(&av_pair(0, &[])); // EOL

    let flags = NEGOTIATE_UNICODE
        | REQUEST_TARGET
        | NEGOTIATE_SIGN
        | NEGOTIATE_NTLM
        | NEGOTIATE_ALWAYS_SIGN
        | NEGOTIATE_EXTENDED_SESSIONSECURITY
        | NEGOTIATE_TARGET_INFO
        | NEGOTIATE_128
        | NEGOTIATE_56
        | NEGOTIATE_KEY_EXCH;

    let header_len = 56usize;
    let target_off = header_len;
    let info_off = target_off + target.len();

    let mut m = Vec::with_capacity(info_off + info.len());
    m.extend_from_slice(NTLMSSP_SIGNATURE);
    m.extend_from_slice(&MSG_CHALLENGE.to_le_bytes());
    // TargetName fields
    m.extend_from_slice(&(target.len() as u16).to_le_bytes());
    m.extend_from_slice(&(target.len() as u16).to_le_bytes());
    m.extend_from_slice(&(target_off as u32).to_le_bytes());
    m.extend_from_slice(&flags.to_le_bytes());
    m.extend_from_slice(server_challenge);
    m.extend_from_slice(&[0u8; 8]); // reserved
    // TargetInfo fields
    m.extend_from_slice(&(info.len() as u16).to_le_bytes());
    m.extend_from_slice(&(info.len() as u16).to_le_bytes());
    m.extend_from_slice(&(info_off as u32).to_le_bytes());
    m.extend_from_slice(&[6, 1, 0, 0, 0, 0, 0, 15]); // version, NTLMSSP revision 15
    debug_assert_eq!(m.len(), header_len);
    m.extend_from_slice(&target);
    m.extend_from_slice(&info);
    m
}

fn hmac_md5(key: &[u8], data: &[u8]) -> [u8; 16] {
    let mut mac = HmacMd5::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// NTOWFv2: the user's key, derived from password, user, and domain.
fn ntowf_v2(user: &str, domain: &str, password: &str) -> [u8; 16] {
    let nt_hash = Md4::digest(string_to_utf16(password));
    let mut identity = string_to_utf16(&user.to_uppercase());
    identity.extend_from_slice(&string_to_utf16(domain));
    hmac_md5(&nt_hash, &identity)
}

/// RC4, used only to unwrap the client's exported session key.
fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut s: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j
            .wrapping_add(s[i])
            .wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|b| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[i as usize]);
            s.swap(i as usize, j as usize);
            let k = s[(s[i as usize].wrapping_add(s[j as usize])) as usize];
            b ^ k
        })
        .collect()
}

/// Verify an NTLM AUTHENTICATE (type 3) message and derive the session key.
///
/// Returns `None` when the proof does not match, which the caller must map to
/// `STATUS_LOGON_FAILURE` without saying which part was wrong.
pub fn verify(
    msg: &[u8],
    server_challenge: &[u8; 8],
    creds: &Credentials,
) -> Option<Authenticated> {
    if !is_authenticate(msg) {
        return None;
    }
    let nt_response = field(msg, 20);
    let domain = utf16_to_string(field(msg, 28));
    let user = utf16_to_string(field(msg, 36));
    let session_key_field = field(msg, 52);
    let flags = if msg.len() >= 64 {
        u32::from_le_bytes(msg[60..64].try_into().unwrap())
    } else {
        0
    };

    if nt_response.len() < 16 {
        return None;
    }
    if !user.eq_ignore_ascii_case(&creds.user) {
        return None;
    }

    let (proof, blob) = nt_response.split_at(16);

    // The client's domain is part of the key derivation, so it must be used as
    // sent rather than the server's configured one, or the proof will not match
    // for clients that default to the machine name.
    let key = ntowf_v2(&user, &domain, &creds.password);

    let mut to_mac = server_challenge.to_vec();
    to_mac.extend_from_slice(blob);
    let expected = hmac_md5(&key, &to_mac);

    // Constant-time compare: this is a password proof.
    let matches = expected
        .iter()
        .zip(proof)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0;
    if !matches {
        return None;
    }

    let session_base_key = hmac_md5(&key, proof);
    let exported = if flags & NEGOTIATE_KEY_EXCH != 0 && session_key_field.len() == 16 {
        let plain = rc4(&session_base_key, session_key_field);
        let mut out = [0u8; 16];
        out.copy_from_slice(&plain);
        out
    } else {
        session_base_key
    };

    Some(Authenticated { user, session_key: exported })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials {
            user: "alice".into(),
            password: "hunter2".into(),
            domain: "LFS".into(),
        }
    }

    /// Build a type 3 message the way a client would, to check the server side
    /// against an independent construction of the same maths.
    fn client_authenticate(
        user: &str,
        domain: &str,
        password: &str,
        challenge: &[u8; 8],
    ) -> Vec<u8> {
        let key = ntowf_v2(user, domain, password);
        let blob = b"\x01\x01\x00\x00fake-client-blob".to_vec();
        let mut to_mac = challenge.to_vec();
        to_mac.extend_from_slice(&blob);
        let proof = hmac_md5(&key, &to_mac);

        let mut nt_response = proof.to_vec();
        nt_response.extend_from_slice(&blob);
        let domain_u = string_to_utf16(domain);
        let user_u = string_to_utf16(user);

        // 8 signature + 4 type + 6 field descriptors + 4 flags + 8 version.
        let header = 72usize;
        let nt_off = header;
        let dom_off = nt_off + nt_response.len();
        let user_off = dom_off + domain_u.len();

        let mut m = Vec::new();
        m.extend_from_slice(NTLMSSP_SIGNATURE);
        m.extend_from_slice(&MSG_AUTHENTICATE.to_le_bytes());
        let mut fields = |len: usize, off: usize| {
            m.extend_from_slice(&(len as u16).to_le_bytes());
            m.extend_from_slice(&(len as u16).to_le_bytes());
            m.extend_from_slice(&(off as u32).to_le_bytes());
        };
        fields(0, nt_off); // LM response
        fields(nt_response.len(), nt_off);
        fields(domain_u.len(), dom_off);
        fields(user_u.len(), user_off);
        fields(0, user_off); // workstation
        fields(0, user_off); // session key
        m.extend_from_slice(&0u32.to_le_bytes()); // flags: no key exchange
        m.extend_from_slice(&[0u8; 8]); // version
        assert_eq!(m.len(), header);
        m.extend_from_slice(&nt_response);
        m.extend_from_slice(&domain_u);
        m.extend_from_slice(&user_u);
        m
    }

    #[test]
    fn accepts_a_correct_password() {
        let ch = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let msg = client_authenticate("alice", "LFS", "hunter2", &ch);
        let auth = verify(&msg, &ch, &creds()).expect("correct password must authenticate");
        assert_eq!(auth.user, "alice");
    }

    #[test]
    fn rejects_a_wrong_password() {
        let ch = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let msg = client_authenticate("alice", "LFS", "wrong", &ch);
        assert!(verify(&msg, &ch, &creds()).is_none());
    }

    #[test]
    fn rejects_a_replay_against_a_different_challenge() {
        let msg = client_authenticate("alice", "LFS", "hunter2", &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(
            verify(&msg, &[9, 9, 9, 9, 9, 9, 9, 9], &creds()).is_none(),
            "a response captured for one challenge must not authenticate against another"
        );
    }

    #[test]
    fn rejects_an_unknown_user() {
        let ch = [1u8; 8];
        let msg = client_authenticate("mallory", "LFS", "hunter2", &ch);
        assert!(verify(&msg, &ch, &creds()).is_none());
    }

    #[test]
    fn finds_ntlm_inside_spnego_wrapping() {
        let token = challenge(&[0u8; 8], "LFS", "LFS");
        let wrapped = spnego_neg_token_resp(&token);
        let found = find_ntlm_message(&wrapped).expect("token must be locatable");
        assert_eq!(message_type(found), Some(MSG_CHALLENGE));
    }

    #[test]
    fn rc4_is_its_own_inverse() {
        let key = b"sixteen byte key";
        let data = b"exported session";
        assert_eq!(rc4(key, &rc4(key, data)), data);
    }
}

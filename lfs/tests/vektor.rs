//! Write path for the vektor backend, against a stand-in for the API.
//!
//! The mock speaks only the four calls the backend makes, which is enough to
//! assert the thing that matters: that a file written through the filesystem
//! arrives as an upload with the right name, the right document, and the right
//! bytes.

use std::collections::HashMap;
use std::sync::Arc;

use lfs::fs::FileSystem;
use lfs::fs::vektor::VektorSpace;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct Space {
    /// key -> (originalName, documentId, bytes)
    uploads: HashMap<String, (String, Option<String>, Vec<u8>)>,
    posts: Vec<(String, Option<String>, usize)>,
    deletes: Vec<String>,
    reverse_listings: bool,
}

fn json(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn query_param(target: &str, key: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if let (b'%', true) = (bytes[i], i + 2 < bytes.len())
            && let Ok(b) = u8::from_str_radix(&value[i + 1..i + 3], 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Start the stand-in server; returns its port and the state it records.
async fn mock_server(state: Arc<Mutex<Space>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                // One connection carries many requests: a pooled client sends
                // its next request down the same socket, and a mock that reads
                // only the first makes every test flaky.
                let mut pending: Vec<u8> = Vec::new();
                loop {
                    // Accumulate until a complete request (headers + declared
                    // body) is in hand.
                    let (head_end, content_length) = loop {
                        if let Some(at) = find_headers_end(&pending) {
                            let head = String::from_utf8_lossy(&pending[..at]).to_string();
                            break (at, content_length_of(&head));
                        }
                        let mut chunk = vec![0u8; 16384];
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => pending.extend_from_slice(&chunk[..n]),
                        }
                    };
                    while pending.len() < head_end + content_length {
                        let mut chunk = vec![0u8; 16384];
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => pending.extend_from_slice(&chunk[..n]),
                        }
                    }

                    let head = String::from_utf8_lossy(&pending[..head_end]).to_string();
                    let body = pending[head_end..head_end + content_length].to_vec();
                    pending.drain(..head_end + content_length);

                    let request_line = head.lines().next().unwrap_or_default().to_string();
                    let mut parts = request_line.split(' ');
                    let method = parts.next().unwrap_or_default().to_string();
                    let target = parts.next().unwrap_or_default().to_string();
                    let path = target.split('?').next().unwrap_or_default().to_string();

                    // Built as bytes, and no lock is held past this block: the
                    // socket write is an await, and a guard cannot cross one.
                    let response: Vec<u8> = if path == "/api/v1/spaces" {
                        json(r#"[{"id":"space_x","slug":"test"}]"#).into_bytes()
                    } else if path.ends_with("/documents") {
                        json(r#"{"documents":[{"id":"doc_1","slug":"notes","updatedAt":"2026-01-02T03:04:05.000Z"}]}"#).into_bytes()
                    } else if path.ends_with("/uploads") && method == "GET" {
                        let mut files: Vec<String> = {
                            let state = state.lock();
                            state
                                .uploads
                                .iter()
                                .map(|(key, (name, doc, bytes))| {
                                    let doc = match doc {
                                        Some(d) => format!("\"{d}\""),
                                        None => "null".into(),
                                    };
                                    format!(
                                        r#"{{"key":"{key}","size":{},"originalName":"{name}","documentId":{doc},"updatedAt":"2026-01-01T00:00:00.000Z"}}"#,
                                        bytes.len()
                                    )
                                })
                                .collect()
                        };
                        files.sort();
                        if state.lock().reverse_listings {
                            files.reverse();
                        }
                        json(&format!(r#"{{"files":[{}]}}"#, files.join(","))).into_bytes()
                    } else if path.ends_with("/uploads") && method == "POST" {
                        let name = query_param(&target, "filename").unwrap_or_default();
                        let doc = query_param(&target, "documentId");
                        // Content addressed, exactly as the real server does it.
                        let key = format!("ab/{:016x}.bin", seahash(&body));
                        let len = body.len();
                        {
                            let mut state = state.lock();
                            state.posts.push((name.clone(), doc.clone(), len));
                            state.uploads.insert(key.clone(), (name, doc, body));
                        }
                        json(&format!(r#"{{"key":"{key}","url":"/x","size":{len}}}"#)).into_bytes()
                    } else if method == "DELETE" {
                        let segments: Vec<&str> = path.split('/').collect();
                        let n = segments.len();
                        let key = format!("{}/{}", segments[n - 2], segments[n - 1]);
                        {
                            let mut state = state.lock();
                            state.deletes.push(key.clone());
                            state.uploads.remove(&key);
                        }
                        json("{}").into_bytes()
                    } else if method == "GET" {
                        let segments: Vec<&str> = path.split('/').collect();
                        let n = segments.len();
                        let key = format!("{}/{}", segments[n - 2], segments[n - 1]);
                        let found = state.lock().uploads.get(&key).map(|(_, _, b)| b.clone());
                        match found {
                            Some(bytes) => {
                                let range = head.lines().find_map(|l| {
                                    let (k, v) = l.split_once(": ")?;
                                    k.eq_ignore_ascii_case("range")
                                        .then(|| v.trim().to_string())
                                });
                                let (start, end) = match range
                                    .as_deref()
                                    .and_then(|r| r.strip_prefix("bytes="))
                                    .and_then(|r| r.split_once('-'))
                                {
                                    Some((a, b)) => (
                                        a.parse::<usize>().unwrap_or(0),
                                        b.parse::<usize>().unwrap_or(bytes.len().saturating_sub(1)),
                                    ),
                                    None => (0, bytes.len().saturating_sub(1)),
                                };
                                let slice =
                                    &bytes[start.min(bytes.len())..(end + 1).min(bytes.len())];
                                let mut out = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\n\r\n",
                                    slice.len()
                                )
                                .into_bytes();
                                out.extend_from_slice(slice);
                                out
                            }
                            None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(),
                        }
                    } else {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()
                    };

                    if socket.write_all(&response).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

/// Any stable content hash will do; the point is that identical bytes give an
/// identical key, which is what the rename path depends on.
fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|at| at + 4)
}

fn content_length_of(head: &str) -> usize {
    head.lines()
        .find_map(|line| {
            let (k, v) = line.split_once(": ")?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn seahash(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

async fn mount(writable: bool) -> (Arc<dyn FileSystem>, Arc<Mutex<Space>>, tempdir::Dir) {
    let state = Arc::new(Mutex::new(Space::default()));
    let port = mock_server(Arc::clone(&state)).await;
    let dir = tempdir::Dir::new("lfs-vektor");
    let fs = open(port, &dir, writable).await;
    (fs, state, dir)
}

async fn open(port: u16, dir: &tempdir::Dir, writable: bool) -> Arc<dyn FileSystem> {
    VektorSpace::open(
        &format!("vektor+http://127.0.0.1:{port}/test"),
        dir.path(),
        writable,
    )
    .await
    .unwrap()
}

mod tempdir {
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A directory of its own per test.
    ///
    /// The counter matters: tests run in parallel and a clock alone is not
    /// fine-grained enough to separate them, so two would share a directory and
    /// the first to finish would delete the other's scratch files.
    static SEQ: AtomicU64 = AtomicU64::new(0);

    pub struct Dir(std::path::PathBuf);
    impl Dir {
        pub fn new(tag: &str) -> Dir {
            let p = std::env::temp_dir().join(format!(
                "{tag}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[tokio::test]
async fn a_document_folder_exists_even_when_empty() {
    // A file cannot be written into a document that has no uploads yet unless
    // the folder is offered in the first place.
    let (fs, _state, _dir) = mount(false).await;
    let (entries, _) = fs.readdir(fs.root(), 0, 100).await.unwrap();
    let names: Vec<String> = entries
        .iter()
        .map(|(n, _)| String::from_utf8_lossy(n).to_string())
        .collect();
    assert!(names.contains(&"notes".to_string()), "got {names:?}");
    assert!(names.contains(&"unattached".to_string()));
}

#[tokio::test]
async fn every_directory_has_a_timestamp() {
    let (fs, _state, _dir) = mount(false).await;

    let root = fs.getattr(fs.root()).await.unwrap();
    assert_ne!(root.mtime.secs, 0);

    let (entries, _) = fs.readdir(fs.root(), 0, 100).await.unwrap();
    for (name, attr) in entries {
        assert_ne!(
            attr.mtime.secs,
            0,
            "directory {:?} must not report the Unix epoch",
            String::from_utf8_lossy(&name)
        );
    }

    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();
    assert_eq!(fs.getattr(notes).await.unwrap().mtime.secs, 1_767_323_045);
}

#[tokio::test]
async fn filesystem_and_remote_object_ids_survive_restart_and_listing_reorder() {
    let state = Arc::new(Mutex::new(Space::default()));
    {
        let mut state = state.lock();
        state.uploads.insert(
            "aa/first.mov".into(),
            ("clip.mov".into(), Some("doc_1".into()), b"first".to_vec()),
        );
        state.uploads.insert(
            "bb/second.mov".into(),
            (
                "clip.mov".into(),
                Some("doc_1".into()),
                b"second".to_vec(),
            ),
        );
    }
    let port = mock_server(Arc::clone(&state)).await;
    let dir = tempdir::Dir::new("lfs-vektor-identities");

    let first = open(port, &dir, false).await;
    let filesystem_id = first.filesystem_id();
    let folder_ino = first.lookup(first.root(), b"notes").await.unwrap();
    let first_ino = first.lookup(folder_ino, b"clip.mov").await.unwrap();
    let second_ino = first.lookup(folder_ino, b"clip (2).mov").await.unwrap();
    drop(first);

    state.lock().reverse_listings = true;
    let reopened = open(port, &dir, false).await;
    let reopened_folder = reopened.lookup(reopened.root(), b"notes").await.unwrap();
    assert_ne!(filesystem_id, 0);
    assert_eq!(reopened.filesystem_id(), filesystem_id);
    assert_eq!(reopened_folder, folder_ino);
    assert_eq!(
        reopened
            .lookup(reopened_folder, b"clip.mov")
            .await
            .unwrap(),
        first_ino
    );
    assert_eq!(
        reopened
            .lookup(reopened_folder, b"clip (2).mov")
            .await
            .unwrap(),
        second_ino
    );
}

#[tokio::test]
async fn delete_and_recreate_never_reuses_an_inode() {
    let state = Arc::new(Mutex::new(Space::default()));
    let port = mock_server(Arc::clone(&state)).await;
    let dir = tempdir::Dir::new("lfs-vektor-tombstone");
    let fs = open(port, &dir, true).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();

    let (old_ino, _) = fs.create(notes, b"clip.mov", 0o644).await.unwrap();
    fs.write(old_ino, 0, b"same bytes").await.unwrap();
    fs.sync().await.unwrap();
    fs.remove(notes, b"clip.mov").await.unwrap();

    let (new_ino, _) = fs.create(notes, b"clip.mov", 0o644).await.unwrap();
    fs.write(new_ino, 0, b"same bytes").await.unwrap();
    fs.sync().await.unwrap();
    assert_ne!(new_ino, old_ino);
    drop(fs);

    let reopened = open(port, &dir, true).await;
    let notes = reopened.lookup(reopened.root(), b"notes").await.unwrap();
    assert_eq!(reopened.lookup(notes, b"clip.mov").await.unwrap(), new_ino);
}

#[tokio::test]
async fn writing_a_file_uploads_it_to_its_document() {
    let (fs, state, _dir) = mount(true).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();

    let (ino, _) = fs.create(notes, b"report.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"the contents").await.unwrap();
    // Read-after-write comes from the buffer; nothing is uploaded yet.
    assert_eq!(fs.read(ino, 0, 100).await.unwrap().0, b"the contents");
    assert!(state.lock().posts.is_empty(), "uploaded before the flush");

    fs.sync().await.unwrap();

    let state = state.lock();
    assert_eq!(state.posts.len(), 1);
    let (name, doc, size) = &state.posts[0];
    assert_eq!(name, "report.txt");
    assert_eq!(
        doc.as_deref(),
        Some("doc_1"),
        "must attach to the folder's document"
    );
    assert_eq!(*size, 12);
}

#[tokio::test]
async fn overwriting_removes_the_object_it_replaced() {
    // A key is a content hash, so new bytes land under a new key and the old
    // object would be orphaned if nothing deleted it.
    let (fs, state, _dir) = mount(true).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();

    let (ino, _) = fs.create(notes, b"f.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"first").await.unwrap();
    fs.sync().await.unwrap();
    let first_key = state.lock().uploads.keys().next().unwrap().clone();

    fs.write(ino, 0, b"second and longer").await.unwrap();
    fs.sync().await.unwrap();

    let state = state.lock();
    assert!(
        state.deletes.contains(&first_key),
        "the replaced upload must be deleted"
    );
    assert_eq!(state.uploads.len(), 1, "exactly one object should remain");
    let (_, _, bytes) = state.uploads.values().next().unwrap();
    assert_eq!(bytes, b"second and longer");
}

#[tokio::test]
async fn renaming_keeps_the_object_and_changes_the_name() {
    // Identical bytes hash to the same key, where the server updates the name
    // in place. Deleting the "old" key here would delete the file itself.
    let (fs, state, _dir) = mount(true).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();

    let (ino, _) = fs.create(notes, b"before.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"unchanging").await.unwrap();
    fs.sync().await.unwrap();

    fs.rename(notes, b"before.txt", notes, b"after.txt")
        .await
        .unwrap();

    let state = state.lock();
    assert_eq!(
        state.uploads.len(),
        1,
        "a rename must not create a second object"
    );
    assert!(
        state.deletes.is_empty(),
        "a rename must not delete the file"
    );
    let (name, _, bytes) = state.uploads.values().next().unwrap();
    assert_eq!(name, "after.txt");
    assert_eq!(bytes, b"unchanging");
}

#[tokio::test]
async fn moving_between_documents_is_refused() {
    // A space keeps an upload with the document that authorizes it, so a move
    // would silently change who can read the file.
    let (fs, _state, _dir) = mount(true).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();
    let loose = fs.lookup(fs.root(), b"unattached").await.unwrap();

    let (ino, _) = fs.create(notes, b"x.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"x").await.unwrap();
    fs.sync().await.unwrap();

    assert!(fs.rename(notes, b"x.txt", loose, b"x.txt").await.is_err());
}

#[tokio::test]
async fn a_read_only_mount_refuses_every_mutation() {
    let (fs, _state, _dir) = mount(false).await;
    let notes = fs.lookup(fs.root(), b"notes").await.unwrap();
    assert!(!fs.writable());
    assert!(fs.create(notes, b"nope.txt", 0o644).await.is_err());
    assert!(fs.mkdir(fs.root(), b"nodir", 0o755).await.is_err());
}

#[tokio::test]
async fn mkdir_is_refused_because_a_folder_is_a_document() {
    let (fs, _state, _dir) = mount(true).await;
    assert!(fs.mkdir(fs.root(), b"newdoc", 0o755).await.is_err());
}

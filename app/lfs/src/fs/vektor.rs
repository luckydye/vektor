//! A vektor space, mounted as its files.
//!
//! A space keeps documents and uploads. This presents the uploads — the files
//! people attached — laid out by the document they belong to:
//!
//! ```text
//! /design-notes/diagram.png
//! /design-notes/notes.pdf
//! /release-plan/chart.svg
//! /unattached/screenshot.png
//! ```
//!
//! Which is not how they are stored. On the server an upload is content
//! addressed, named by its hash, and the name a person recognises lives only in
//! the space's index. Two API calls put that back together: the document list
//! supplies the folder names, and the upload list supplies each file's original
//! name and the document it hangs off.
//!
//! Read-only, and over the HTTP API rather than the space's database, so it
//! works against a remote instance and its access control decides what is
//! visible.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{FsError, Result};
use crate::storage::meta::{Attr, Ino, Kind, ROOT_INO, SetAttr, Timespec};

use super::api::FileSystem;

/// How long a listing is trusted before being fetched again. Uploads change
/// far less often than a client lists them.
const LISTING_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Folder for uploads attached to no document.
const UNATTACHED: &str = "unattached";

/// How much is fetched, and cached, per miss.
///
/// One HTTP request per read makes a video player exceed any sane server rate
/// limit within seconds of scrubbing. Fetching an aligned block and keeping it
/// turns a burst of small reads into one request, and a re-read into none.
const BLOCK: u64 = 4 * 1024 * 1024;

/// How many times a rate-limited request is retried before giving up.
const RATE_LIMIT_RETRIES: u32 = 4;

/// How long a file must go unwritten before it is uploaded.
///
/// An upload sends the whole file and creates a new content hash, so uploading
/// per write would leave a trail of orphaned objects. Waiting for a pause turns
/// a client's stream of writes into one upload.
const WRITE_IDLE: std::time::Duration = std::time::Duration::from_millis(1500);

const IDENTITY_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
struct UploadEntry {
    key: String,
    size: u64,
    #[serde(rename = "documentId")]
    document_id: Option<String>,
    #[serde(rename = "originalName")]
    original_name: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UploadList {
    files: Vec<UploadEntry>,
}

#[derive(Debug, Deserialize)]
struct DocumentEntry {
    id: String,
    slug: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SpaceEntry {
    id: String,
    slug: String,
}

/// `/api/v1/spaces` answers with a bare array.
#[derive(Debug, Deserialize)]
struct SpaceList(Vec<SpaceEntry>);

#[derive(Debug, Deserialize)]
struct DocumentList {
    documents: Vec<DocumentEntry>,
}

#[derive(Debug, Clone)]
enum Node {
    /// A folder standing for a document, or the root. Its name lives in the
    /// parent's entry list; the document id is what an upload into it needs.
    Dir {
        document: Option<String>,
        modified: u64,
    },
    File {
        key: String,
        /// The name the upload carries, which is what a rename changes.
        name: String,
        document: Option<String>,
        size: u64,
        modified: u64,
    },
}

/// A file being written: its bytes live in a scratch file until uploaded.
struct Pending {
    scratch: PathBuf,
    size: u64,
    last_write: std::time::Instant,
}

/// The part of the Vektor namespace that must survive process restarts.
/// Object identities are removed when their remote objects disappear, while
/// `next_ino` only advances, so a deleted inode is never reused for a new file.
#[derive(Debug, Serialize, Deserialize)]
struct DurableIdentities {
    version: u32,
    scope: String,
    next_ino: Ino,
    objects: HashMap<String, Ino>,
}

struct Tree {
    nodes: HashMap<Ino, Node>,
    /// Directory inode -> its children, in name order.
    children: HashMap<Ino, Vec<(Vec<u8>, Ino)>>,
    /// Stable identity per path, so a file keeps its inode across refreshes.
    /// Clients cache inode numbers and misbehave when they move.
    by_path: HashMap<String, Ino>,
    /// Remote logical identity -> inode. Unlike paths, document ids and upload
    /// keys survive renames and API response reordering.
    by_identity: HashMap<String, Ino>,
    /// Desktop metadata held back from the space: inode -> (parent, name).
    /// These exist only on this machine, so a refresh — which rebuilds the
    /// tree from the API — has to put them back afterwards.
    local: HashMap<Ino, (Ino, Vec<u8>)>,
    next_ino: Ino,
    fetched: Option<std::time::Instant>,
}

pub struct VektorSpace {
    client: reqwest::Client,
    host: String,
    space_id: Mutex<String>,
    name: String,
    location: String,
    token: Option<String>,
    /// Where fetched blocks are kept. An upload's key is the hash of its
    /// content, so a cached block can never be stale and needs no validation.
    cache_dir: PathBuf,
    scratch_dir: PathBuf,
    identity_path: PathBuf,
    writable: bool,
    owner: (u32, u32),
    pending: tokio::sync::Mutex<HashMap<Ino, Pending>>,
    tree: Mutex<Tree>,
}

impl VektorSpace {
    /// `vektor://host/space`, where `space` is either a space id or the slug
    /// from the space's URL.
    ///
    /// `vektor://` is HTTPS. A local instance served over plain HTTP is
    /// `vektor+http://127.0.0.1:8080/space` — spelled out, because silently
    /// sending a bearer token in clear text is not something to infer from a
    /// hostname.
    ///
    /// `token` is sent as a bearer token; `None` only works against a server
    /// running with `--no-auth`. The CLI finds one with [`access_token`].
    pub async fn open(
        location: &str,
        state_dir: &Path,
        writable: bool,
        token: Option<String>,
    ) -> Result<Arc<VektorSpace>> {
        let cache_dir = state_dir.join("blocks");
        let scratch_dir = state_dir.join("scratch");
        let identity_path = state_dir.join("identities.json");
        std::fs::create_dir_all(&cache_dir)?;
        // Scratch files are reachable only through the in-memory pending map,
        // so anything a previous process left here is unreachable now. Local
        // metadata files are held in scratch for the life of a mount, which
        // would otherwise make this grow without bound.
        let _ = std::fs::remove_dir_all(&scratch_dir);
        std::fs::create_dir_all(&scratch_dir)?;
        let (scheme, rest) = if let Some(rest) = location.strip_prefix("vektor+http://") {
            ("http", rest)
        } else if let Some(rest) = location.strip_prefix("vektor://") {
            ("https", rest)
        } else if let Some(rest) = location.strip_prefix("https://") {
            ("https", rest)
        } else if let Some(rest) = location.strip_prefix("http://") {
            ("http", rest)
        } else {
            return Err(FsError::Backend(format!(
                "expected vektor://host/space, got {location}"
            )));
        };

        let (authority, space) = rest.split_once('/').ok_or_else(|| {
            FsError::Backend(format!(
                "no space in {location}; expected vektor://host/space"
            ))
        })?;
        let space = space.trim_end_matches('/').to_string();
        if space.is_empty() {
            return Err(FsError::Backend(format!("no space in {location}")));
        }

        let fs = Arc::new(VektorSpace {
            client: reqwest::Client::new(),
            host: format!("{scheme}://{authority}"),
            name: space.clone(),
            location: format!("vektor://{authority}/{space}"),
            // Resolved below, once there is a client to ask with.
            space_id: Mutex::new(space),
            token,
            owner: super::owner_of(state_dir),
            cache_dir,
            scratch_dir,
            identity_path,
            writable,
            pending: tokio::sync::Mutex::new(HashMap::new()),
            tree: Mutex::new(Tree {
                nodes: HashMap::from([(
                    ROOT_INO,
                    Node::Dir {
                        document: None,
                        modified: Timespec::now().secs,
                    },
                )]),
                children: HashMap::new(),
                by_path: HashMap::from([(String::new(), ROOT_INO)]),
                by_identity: HashMap::new(),
                local: HashMap::new(),
                next_ino: ROOT_INO + 1,
                fetched: None,
            }),
        });

        fs.resolve_space().await?;
        fs.load_identities()?;
        // Fail at mount time rather than on the first `ls`.
        fs.refresh().await?;
        Ok(fs)
    }

    /// Turn a slug into the id the API paths need.
    ///
    /// The URL a person copies out of vektor carries the slug, not the id, so
    /// accepting only the id would mean every mount starts with a lookup done
    /// by hand.
    async fn resolve_space(&self) -> Result<()> {
        let given = self.space_id.lock().clone();
        if given.starts_with("space_") {
            return Ok(());
        }
        let spaces: SpaceList = self.get_json("/api/v1/spaces").await?;
        let found = spaces
            .0
            .iter()
            .find(|s| s.slug == given || s.id == given)
            .ok_or_else(|| {
                FsError::Backend(format!(
                    "no space {given:?} here; visible: {}",
                    spaces
                        .0
                        .iter()
                        .map(|s| s.slug.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        tracing::info!("space {:?} is {}", found.slug, found.id);
        *self.space_id.lock() = found.id.clone();
        Ok(())
    }

    fn space(&self) -> String {
        self.space_id.lock().clone()
    }

    fn identity_scope(&self) -> String {
        format!("vektor:{}:{}", self.host, self.space())
    }

    fn load_identities(&self) -> Result<()> {
        let bytes = match std::fs::read(&self.identity_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let saved: DurableIdentities = serde_json::from_slice(&bytes)
            .map_err(|e| FsError::Corrupt(format!("{}: {e}", self.identity_path.display())))?;
        let scope = self.identity_scope();
        if saved.version != IDENTITY_VERSION {
            return Err(FsError::Corrupt(format!(
                "{} has identity version {}, expected {IDENTITY_VERSION}",
                self.identity_path.display(),
                saved.version
            )));
        }
        if saved.scope != scope {
            return Err(FsError::Corrupt(format!(
                "{} belongs to {:?}, not {:?}",
                self.identity_path.display(),
                saved.scope,
                scope
            )));
        }
        if saved.objects.values().any(|ino| *ino <= ROOT_INO) {
            return Err(FsError::Corrupt(format!(
                "{} contains a reserved inode",
                self.identity_path.display()
            )));
        }
        let minimum_next = saved
            .objects
            .values()
            .copied()
            .max()
            .unwrap_or(ROOT_INO)
            .saturating_add(1);
        if saved.next_ino < minimum_next {
            return Err(FsError::Corrupt(format!(
                "{} would reuse an allocated inode",
                self.identity_path.display()
            )));
        }

        let mut tree = self.tree.lock();
        tree.next_ino = saved.next_ino.max(ROOT_INO + 1);
        tree.by_identity = saved.objects;
        Ok(())
    }

    /// Atomically replace the identity index. A returned inode is not exposed
    /// to a client until its allocation has reached this file.
    fn save_identities(&self, tree: &Tree) -> Result<()> {
        let saved = DurableIdentities {
            version: IDENTITY_VERSION,
            scope: self.identity_scope(),
            next_ino: tree.next_ino,
            objects: tree.by_identity.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&saved)
            .map_err(|e| FsError::Corrupt(format!("serialize identities: {e}")))?;
        let tmp = self
            .identity_path
            .with_extension(format!("json.tmp.{}", std::process::id()));
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.identity_path)?;
        Ok(())
    }

    fn request(&self, url: &str) -> reqwest::RequestBuilder {
        let req = self.client.get(url);
        match &self.token {
            Some(token) => req.bearer_auth(token),
            None => req,
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}{path}", self.host);
        let response = self
            .request(&url)
            .send()
            .await
            .map_err(|e| FsError::Backend(format!("GET {url}: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => FsError::Backend(format!(
                    "GET {url}: {status} — set VEKTOR_ACCESS_TOKEN, or run the server with --no-auth"
                )),
                404 => FsError::NotFound,
                _ => FsError::Backend(format!("GET {url}: {status}")),
            });
        }
        response
            .json::<T>()
            .await
            .map_err(|e| FsError::Backend(format!("GET {url}: malformed response: {e}")))
    }

    /// Rebuild the whole tree: one document listing plus one upload listing.
    ///
    /// The space is small enough that paging per directory would cost more
    /// round trips than it saves, and both listings are needed together anyway
    /// — a file cannot be placed without knowing its document's slug.
    async fn refresh(&self) -> Result<()> {
        {
            let tree = self.tree.lock();
            if tree.fetched.is_some_and(|at| at.elapsed() < LISTING_TTL) {
                return Ok(());
            }
        }

        let documents: DocumentList = self
            .get_json(&format!("/api/v1/spaces/{}/documents", self.space()))
            .await?;
        let uploads: UploadList = self
            .get_json(&format!("/api/v1/spaces/{}/uploads", self.space()))
            .await?;

        let slugs: HashMap<&str, &str> = documents
            .documents
            .iter()
            .map(|d| (d.id.as_str(), d.slug.as_str()))
            .collect();

        // Group first, so a folder is created only when something lands in it.
        // Every document is offered as a folder, even an empty one, so a file
        // can be written into a document that has no uploads yet.
        let mut folders: HashMap<String, Vec<&UploadEntry>> = HashMap::new();
        let mut folder_document: HashMap<String, Option<String>> = HashMap::new();
        let mut folder_modified: HashMap<String, u64> = HashMap::new();
        folders.entry(UNATTACHED.to_string()).or_default();
        folder_document.insert(UNATTACHED.to_string(), None);
        for doc in &documents.documents {
            folders.entry(doc.slug.clone()).or_default();
            folder_document.insert(doc.slug.clone(), Some(doc.id.clone()));
            folder_modified.insert(doc.slug.clone(), parse_timestamp(doc.updated_at.as_deref()));
        }
        for file in &uploads.files {
            let folder = match &file.document_id {
                // A file whose document is not in the listing is one the caller
                // cannot see the document for; it still belongs somewhere.
                Some(id) => slugs.get(id.as_str()).copied().unwrap_or(UNATTACHED),
                None => UNATTACHED,
            };
            folders.entry(folder.to_string()).or_default().push(file);
        }

        let mut tree = self.tree.lock();
        tree.children.clear();
        let mut live_identities = HashSet::new();
        let mut identities_changed = false;

        let mut root_children: Vec<(Vec<u8>, Ino)> = Vec::new();
        let mut folder_names: Vec<&String> = folders.keys().collect();
        folder_names.sort();
        let refreshed_at = Timespec::now().secs;
        let mut root_modified = 0;

        for folder in folder_names {
            let document = folder_document.get(folder).cloned().flatten();
            let from_api = folders[folder]
                .iter()
                .map(|file| parse_timestamp(file.updated_at.as_deref()))
                .fold(*folder_modified.get(folder).unwrap_or(&0), u64::max);
            // Synthetic folders (notably `unattached`) have no timestamp of
            // their own. Keep their previous value across refreshes, using the
            // first refresh time only when the API has no date to offer.
            let previous = tree
                .by_path
                .get(folder)
                .and_then(|ino| tree.nodes.get(ino))
                .and_then(|node| match node {
                    Node::Dir { modified, .. } => Some(*modified),
                    Node::File { .. } => None,
                })
                .unwrap_or(refreshed_at);
            let modified = if from_api == 0 { previous } else { from_api };
            root_modified = root_modified.max(modified);
            let identity = match &document {
                Some(id) => format!("document:{id}"),
                None => "folder:unattached".to_string(),
            };
            live_identities.insert(identity.clone());
            let dir_ino = intern(
                &mut tree,
                identity,
                folder.clone(),
                Node::Dir {
                    document: document.clone(),
                    modified,
                },
                &mut identities_changed,
            );
            root_children.push((folder.clone().into_bytes(), dir_ino));

            let mut entries: Vec<(Vec<u8>, Ino)> = Vec::new();
            let mut used: HashMap<String, usize> = HashMap::new();
            let mut files = folders[folder].clone();
            files.sort_by(|a, b| {
                a.original_name
                    .cmp(&b.original_name)
                    .then_with(|| a.key.cmp(&b.key))
            });
            for file in files {
                let base = file
                    .original_name
                    .clone()
                    // Nothing recorded the name. Older servers do not send one
                    // at all, so this is the whole listing on those, not a rare
                    // fallback — worth making readable rather than echoing the
                    // key, whose leading directory just repeats its own first
                    // two characters.
                    .unwrap_or_else(|| short_name(&file.key));
                let name = disambiguate(&mut used, &base);

                let path = format!("{folder}/{name}");
                let node = Node::File {
                    key: file.key.clone(),
                    name: name.clone(),
                    document: document.clone(),
                    size: file.size,
                    modified: parse_timestamp(file.updated_at.as_deref()),
                };
                let identity = format!("upload:{}", file.key);
                live_identities.insert(identity.clone());
                let ino = intern(&mut tree, identity, path, node, &mut identities_changed);
                entries.push((name.into_bytes(), ino));
            }
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            tree.children.insert(dir_ino, entries);
        }

        root_children.sort_by(|a, b| a.0.cmp(&b.0));
        tree.children.insert(ROOT_INO, root_children);

        // The listing above is the whole truth about the space, and the tree
        // was rebuilt from it. Files held back from the space are not in it,
        // so they have to be put back or they would vanish under the client
        // between one refresh and the next.
        let local: Vec<(Ino, (Ino, Vec<u8>))> =
            tree.local.iter().map(|(k, v)| (*k, v.clone())).collect();
        for (ino, (parent, name)) in local {
            if !tree.nodes.contains_key(&parent) {
                // Its document was deleted out from under it; so is it.
                tree.local.remove(&ino);
                tree.nodes.remove(&ino);
                continue;
            }
            let entries = tree.children.entry(parent).or_default();
            if !entries.iter().any(|(_, child)| *child == ino) {
                entries.push((name, ino));
                entries.sort_by(|a, b| a.0.cmp(&b.0));
            }
        }
        if let Some(Node::Dir { modified, .. }) = tree.nodes.get_mut(&ROOT_INO) {
            if root_modified != 0 {
                *modified = root_modified;
            } else if *modified == 0 {
                *modified = refreshed_at;
            }
        }
        let before = tree.by_identity.len();
        tree.by_identity
            .retain(|identity, _| live_identities.contains(identity));
        identities_changed |= tree.by_identity.len() != before;
        if identities_changed {
            self.save_identities(&tree)?;
        }
        tree.fetched = Some(std::time::Instant::now());
        Ok(())
    }

    /// One aligned block, from the local cache or the server.
    ///
    /// Upload keys are content hashes, so a block on disk is valid forever and
    /// the cache needs no expiry or revalidation.
    async fn block(&self, key: &str, index: u64, size: u64) -> Result<Bytes> {
        let path = self
            .cache_dir
            .join(format!("{}.{index}", key.replace('/', "-")));
        if let Ok(data) = std::fs::read(&path) {
            return Ok(Bytes::from(data));
        }

        let start = index * BLOCK;
        if start >= size {
            return Ok(Bytes::new());
        }
        let last = (start + BLOCK).min(size) - 1;
        let data = self.fetch_range(key, start, last).await?;

        // Unique temporary name: concurrent readers race for the same block,
        // and a shared name means one renames the file out from under another.
        let tmp = path.with_extension(format!("{index}.tmp.{}", std::process::id()));
        if std::fs::write(&tmp, &data).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(data)
    }

    /// A ranged GET, retrying when the server says the client is going too fast.
    ///
    /// A player scrubbing through a video produces a burst of reads; without
    /// backoff the first refusal becomes an I/O error and playback stops, when
    /// waiting a moment would have served it.
    async fn fetch_range(&self, key: &str, start: u64, last: u64) -> Result<Bytes> {
        let url = format!("{}/api/v1/spaces/{}/uploads/{key}", self.host, self.space());
        let mut delay = std::time::Duration::from_millis(250);

        for attempt in 0..=RATE_LIMIT_RETRIES {
            let response = self
                .request(&url)
                .header("Range", format!("bytes={start}-{last}"))
                .send()
                .await
                .map_err(|e| FsError::Backend(format!("GET {url}: {e}")))?;

            if response.status().as_u16() == 429 {
                if attempt == RATE_LIMIT_RETRIES {
                    return Err(FsError::Backend(format!(
                        "GET {url}: rate limited after {RATE_LIMIT_RETRIES} retries"
                    )));
                }
                // Honour the server's own figure when it gives one.
                let wait = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(std::time::Duration::from_secs)
                    .unwrap_or(delay);
                tracing::warn!("rate limited, waiting {:?} before retrying", wait);
                tokio::time::sleep(wait).await;
                delay *= 2;
                continue;
            }

            if !response.status().is_success() {
                return Err(FsError::Backend(format!(
                    "GET {url}: {}",
                    response.status()
                )));
            }
            return response
                .bytes()
                .await
                .map_err(|e| FsError::Backend(format!("GET {url}: {e}")));
        }
        unreachable!("the loop returns on its last attempt")
    }

    // ---- writing ----

    fn require_writable(&self) -> Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(FsError::ReadOnly)
        }
    }

    /// The scratch file holding an inode's bytes, filled from the existing
    /// upload on first write so a partial write keeps the rest of the file.
    async fn begin_write(&self, ino: Ino, node: &Node) -> Result<PathBuf> {
        let mut pending = self.pending.lock().await;
        if let Some(entry) = pending.get(&ino) {
            return Ok(entry.scratch.clone());
        }
        let Node::File { key, size, .. } = node else {
            return Err(FsError::IsDir);
        };

        let scratch = self.scratch_dir.join(format!("{ino}.part"));
        let existing = if *size > 0 && !key.is_empty() {
            self.fetch_range(key, 0, size - 1).await.unwrap_or_default()
        } else {
            Bytes::new()
        };
        std::fs::write(&scratch, &existing)?;
        pending.insert(
            ino,
            Pending {
                scratch: scratch.clone(),
                size: existing.len() as u64,
                last_write: std::time::Instant::now(),
            },
        );
        Ok(scratch)
    }

    /// Upload one buffered file, replacing the upload it came from.
    ///
    /// A key is the hash of the content, so new bytes land under a new key and
    /// the old object has to be deleted; unchanged bytes land on the same key,
    /// where the server updates the name in place.
    async fn upload(&self, ino: Ino, entry: Pending) -> Result<()> {
        let (old_key, name, document) = {
            let tree = self.tree.lock();
            match tree.nodes.get(&ino) {
                Some(Node::File {
                    key,
                    name,
                    document,
                    ..
                }) => (key.clone(), name.clone(), document.clone()),
                _ => return Err(FsError::NotFound),
            }
        };

        let data = std::fs::read(&entry.scratch)?;
        let mut url = format!(
            "{}/api/v1/spaces/{}/uploads?filename={}",
            self.host,
            self.space(),
            urlencode(&name)
        );
        if let Some(doc) = &document {
            url.push_str(&format!("&documentId={doc}"));
        }

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/octet-stream")
            .body(data);
        let response = match &self.token {
            Some(token) => response.bearer_auth(token),
            None => response,
        };
        let response = response
            .send()
            .await
            .map_err(|e| FsError::Backend(format!("POST {url}: {e}")))?;

        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => FsError::Backend(format!(
                    "POST {url}: {} — the token needs editor permission",
                    response.status()
                )),
                _ => FsError::Backend(format!("POST {url}: {}", response.status())),
            });
        }
        #[derive(Deserialize)]
        struct Uploaded {
            key: String,
        }
        let uploaded: Uploaded = response
            .json()
            .await
            .map_err(|e| FsError::Backend(format!("POST {url}: malformed response: {e}")))?;

        if !old_key.is_empty() && old_key != uploaded.key {
            // The content changed, so the old object is now unreferenced.
            if let Err(e) = self.delete_key(&old_key).await {
                tracing::warn!("could not remove the replaced upload {old_key}: {e}");
            }
        }

        let mut tree = self.tree.lock();
        let old_identity = (!old_key.is_empty()).then(|| format!("upload:{old_key}"));
        let new_identity = format!("upload:{}", uploaded.key);
        let identity_changed = old_identity.as_deref() != Some(new_identity.as_str());
        if identity_changed {
            if let Some(old_identity) = old_identity
                && tree.by_identity.get(&old_identity) == Some(&ino)
            {
                tree.by_identity.remove(&old_identity);
            }
            tree.by_identity.insert(new_identity, ino);
        }
        if let Some(Node::File { key, size, .. }) = tree.nodes.get_mut(&ino) {
            *key = uploaded.key.clone();
            *size = entry.size;
        }
        if identity_changed {
            self.save_identities(&tree)?;
        }
        // The listing is stale now: a new file has appeared under a new key.
        tree.fetched = None;
        let _ = std::fs::remove_file(&entry.scratch);
        Ok(())
    }

    async fn delete_key(&self, key: &str) -> Result<()> {
        let url = format!("{}/api/v1/spaces/{}/uploads/{key}", self.host, self.space());
        let request = self.client.delete(&url);
        let request = match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        let response = request
            .send()
            .await
            .map_err(|e| FsError::Backend(format!("DELETE {url}: {e}")))?;
        if !response.status().is_success() {
            return Err(FsError::Backend(format!(
                "DELETE {url}: {}",
                response.status()
            )));
        }
        Ok(())
    }

    /// Upload everything idle long enough, or all of it when `force`.
    ///
    /// Files held back from the space are skipped, so their bytes stay in the
    /// scratch file for as long as the mount lives — which is what serves the
    /// reads, since [`read`](FileSystem::read) prefers a pending entry over the
    /// upload it would otherwise fetch.
    async fn flush_pending(&self, force: bool) -> Result<()> {
        let ready: Vec<Ino> = {
            let local: HashSet<Ino> = self.tree.lock().local.keys().copied().collect();
            let pending = self.pending.lock().await;
            pending
                .iter()
                .filter(|(ino, _)| !local.contains(ino))
                .filter(|(_, p)| force || p.last_write.elapsed() >= WRITE_IDLE)
                .map(|(ino, _)| *ino)
                .collect()
        };
        for ino in ready {
            let entry = {
                let mut pending = self.pending.lock().await;
                match pending.get(&ino) {
                    Some(p) if force || p.last_write.elapsed() >= WRITE_IDLE => {
                        pending.remove(&ino)
                    }
                    _ => None,
                }
            };
            let Some(entry) = entry else { continue };
            let scratch = entry.scratch.clone();
            let size = entry.size;
            if let Err(e) = self.upload(ino, entry).await {
                tracing::error!("upload failed, keeping the bytes to retry: {e}");
                self.pending.lock().await.insert(
                    ino,
                    Pending {
                        scratch,
                        size,
                        last_write: std::time::Instant::now(),
                    },
                );
                return Err(e);
            }
        }
        Ok(())
    }

    fn node(&self, ino: Ino) -> Result<Node> {
        self.tree
            .lock()
            .nodes
            .get(&ino)
            .cloned()
            .ok_or(FsError::NotFound)
    }

    fn attr_of(&self, node: &Node, ino: Ino) -> Attr {
        let (kind, size, modified) = match node {
            Node::Dir { modified, .. } => (Kind::Dir, 0, *modified),
            Node::File { size, modified, .. } => (Kind::File, *size, *modified),
        };
        let time = Timespec {
            secs: modified,
            nanos: 0,
        };
        Attr {
            ino,
            kind,
            // The mode has to match what will actually be allowed, or a
            // writable mount looks locked and a read-only one invites a write.
            mode: match (kind, self.writable) {
                (Kind::Dir, true) => 0o755,
                (Kind::Dir, false) => 0o555,
                (_, true) => 0o644,
                (_, false) => 0o444,
            },
            nlink: 1,
            uid: self.owner.0,
            gid: self.owner.1,
            size,
            atime: time,
            mtime: time,
            ctime: time,
        }
    }
}

/// `VEKTOR_ACCESS_TOKEN`, the same variable vektor's own CLI reads. On macOS a
/// service can instead set `VEKTOR_KEYCHAIN_SERVICE` to a generic-password item name.
pub fn access_token() -> Option<String> {
    if let Some(token) = std::env::var("VEKTOR_ACCESS_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
    {
        return Some(token);
    }

    #[cfg(target_os = "macos")]
    if let Some(service) = std::env::var("VEKTOR_KEYCHAIN_SERVICE")
        .ok()
        .filter(|service| !service.is_empty())
    {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", &service, "-w"])
            .output()
            .ok()?;
        if output.status.success() {
            return String::from_utf8(output.stdout)
                .ok()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty());
        }
    }

    None
}

/// Keep one inode per remote logical object across refreshes and restarts.
fn intern(
    tree: &mut Tree,
    identity: String,
    path: String,
    node: Node,
    identities_changed: &mut bool,
) -> Ino {
    if let Some(&ino) = tree.by_identity.get(&identity) {
        tree.by_path.insert(path, ino);
        tree.nodes.insert(ino, node);
        return ino;
    }
    let ino = tree.next_ino;
    tree.next_ino += 1;
    tree.by_identity.insert(identity, ino);
    tree.by_path.insert(path, ino);
    tree.nodes.insert(ino, node);
    *identities_changed = true;
    ino
}

/// Whether a name is desktop metadata that should never reach the space.
///
/// macOS writes these next to the files a person actually copied: `.DS_Store`
/// for a folder's view settings, and an `._name` AppleDouble carrying the
/// extended attributes of `name` on a filesystem that has nowhere to put them.
/// Uploading them puts junk in the space's index — the thing a person sees —
/// so they are kept on this machine instead, where the tools that write them
/// can still read them back.
fn is_local_only(name: &[u8]) -> bool {
    const NAMES: &[&str] = &[
        ".DS_Store",
        ".localized",
        ".apdisk",
        ".VolumeIcon.icns",
        ".com.apple.timemachine.donotpresent",
        "Thumbs.db",
        "desktop.ini",
    ];
    const PREFIXES: &[&str] = &[
        "._",
        ".Spotlight-V100",
        ".Trashes",
        ".fseventsd",
        ".TemporaryItems",
        ".DocumentRevisions-V100",
    ];

    let Ok(name) = std::str::from_utf8(name) else {
        return false;
    };
    // Finder's custom-folder-icon file is "Icon" followed by a carriage return.
    if name.trim_end_matches('\r') == "Icon" && name.ends_with('\r') {
        return true;
    }
    NAMES.iter().any(|n| n.eq_ignore_ascii_case(name))
        || PREFIXES.iter().any(|p| name.starts_with(p))
}

/// A readable stand-in for a file the server gave no name for.
///
/// `ab/abcdef0123….png` becomes `abcdef0123.png`: the directory segment is the
/// hash's own first two characters, and the full 64 is unreadable at a glance.
/// Truncating risks a collision, which the caller already resolves by suffixing.
fn short_name(key: &str) -> String {
    let base = key.rsplit('/').next().unwrap_or(key);
    let (hash, ext) = match base.rsplit_once('.') {
        Some((hash, ext)) => (hash, Some(ext)),
        None => (base, None),
    };
    let short: String = hash.chars().take(10).collect();
    match ext {
        Some(ext) => format!("{short}.{ext}"),
        None => short,
    }
}

/// Percent-encode a filename for a query string.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Two uploads can share an original name; a directory entry cannot.
fn disambiguate(used: &mut HashMap<String, usize>, base: &str) -> String {
    let count = used.entry(base.to_string()).or_insert(0);
    *count += 1;
    if *count == 1 {
        return base.to_string();
    }
    let n = *count;
    match base.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem} ({n}).{ext}"),
        None => format!("{base} ({n})"),
    }
}

/// Parse an ISO-8601 timestamp into seconds since the epoch.
///
/// Only the shape the API emits is handled; an unparsable value becomes 0,
/// which shows as the epoch rather than failing the listing.
fn parse_timestamp(value: Option<&str>) -> u64 {
    let Some(text) = value else { return 0 };
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let num = |a: usize, b: usize| -> i64 { text[a..b].parse().unwrap_or(0) };
    let (y, mo, d) = (num(0, 4), num(5, 7), num(8, 10));
    let (h, mi, s) = (num(11, 13), num(14, 16), num(17, 19));
    if y < 1970 {
        return 0;
    }
    // Days since the epoch, via the civil-from-days algorithm.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (days * 86_400 + h * 3_600 + mi * 60 + s).max(0) as u64
}

#[async_trait]
impl FileSystem for VektorSpace {
    fn name(&self) -> &str {
        &self.name
    }

    fn location(&self) -> &str {
        &self.location
    }

    fn filesystem_id(&self) -> u64 {
        super::stable_filesystem_id(&self.identity_scope())
    }

    fn root(&self) -> Ino {
        ROOT_INO
    }

    fn writable(&self) -> bool {
        self.writable
    }

    async fn lookup(&self, parent: Ino, name: &[u8]) -> Result<Ino> {
        self.refresh().await?;
        let tree = self.tree.lock();
        tree.children
            .get(&parent)
            .and_then(|entries| entries.iter().find(|(n, _)| n == name))
            .map(|(_, ino)| *ino)
            .ok_or(FsError::NotFound)
    }

    async fn getattr(&self, ino: Ino) -> Result<Attr> {
        Ok(self.attr_of(&self.node(ino)?, ino))
    }

    async fn parent(&self, ino: Ino) -> Result<Ino> {
        if ino == ROOT_INO {
            return Ok(ROOT_INO);
        }
        let tree = self.tree.lock();
        Ok(tree
            .children
            .iter()
            .find(|(_, entries)| entries.iter().any(|(_, child)| *child == ino))
            .map(|(dir, _)| *dir)
            .unwrap_or(ROOT_INO))
    }

    async fn readdir(
        &self,
        dir: Ino,
        start_after: Ino,
        max_entries: usize,
    ) -> Result<(Vec<(Vec<u8>, Attr)>, bool)> {
        self.refresh().await?;
        let tree = self.tree.lock();
        let entries = tree.children.get(&dir).ok_or(FsError::NotDir)?;
        let mut iter = entries.iter().peekable();

        if start_after != 0 {
            let mut found = false;
            for (_, ino) in iter.by_ref() {
                if *ino == start_after {
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(FsError::Inval);
            }
        }

        let mut out = Vec::new();
        while out.len() < max_entries {
            let Some((name, ino)) = iter.next() else {
                break;
            };
            let node = tree.nodes.get(ino).ok_or(FsError::NotFound)?;
            out.push((name.clone(), self.attr_of(node, *ino)));
        }
        Ok((out, iter.peek().is_none()))
    }

    async fn read(&self, ino: Ino, offset: u64, count: u32) -> Result<(Vec<u8>, bool)> {
        let Node::File { key, size, .. } = self.node(ino)? else {
            return Err(FsError::IsDir);
        };

        // Unflushed writes live only in the scratch file. Reading past them
        // would serve the previous upload — or, for a file that has never been
        // uploaded, ask the server for an empty key.
        if let Some(entry) = self.pending.lock().await.get(&ino) {
            let data = std::fs::read(&entry.scratch)?;
            let start = (offset as usize).min(data.len());
            let end = (start + count as usize).min(data.len());
            return Ok((data[start..end].to_vec(), end >= data.len()));
        }

        if offset >= size {
            return Ok((Vec::new(), true));
        }
        let want = (count as u64).min(size - offset);
        if want == 0 {
            // A byte range is inclusive of both ends, so an empty one cannot be
            // spelled; deriving `offset + len - 1` from zero underflows and asks
            // for the whole object.
            return Ok((Vec::new(), false));
        }

        // Serve from aligned blocks, so a player's stream of small reads costs
        // one request per block rather than one per read.
        let mut out = Vec::with_capacity(want as usize);
        let mut pos = offset;
        while pos < offset + want {
            let index = pos / BLOCK;
            let block = self.block(&key, index, size).await?;
            let within = (pos - index * BLOCK) as usize;
            if within >= block.len() {
                break;
            }
            let take = ((offset + want - pos) as usize).min(block.len() - within);
            out.extend_from_slice(&block[within..within + take]);
            pos += take as u64;
        }

        let eof = offset + out.len() as u64 >= size;
        Ok((out, eof))
    }

    async fn readlink(&self, _ino: Ino) -> Result<Vec<u8>> {
        Err(FsError::Inval)
    }

    async fn setattr(&self, ino: Ino, set: SetAttr) -> Result<Attr> {
        self.require_writable()?;
        // Only size is actionable. A space records no mode or owner for an
        // upload, but reporting success keeps `cp` and editors working, since
        // they set those as a matter of course.
        let Some(size) = set.size else {
            return self.getattr(ino).await;
        };
        let node = self.node(ino)?;
        let scratch = self.begin_write(ino, &node).await?;
        let file = std::fs::OpenOptions::new().write(true).open(&scratch)?;
        file.set_len(size)?;
        file.sync_all()?;

        if let Some(entry) = self.pending.lock().await.get_mut(&ino) {
            entry.size = size;
            entry.last_write = std::time::Instant::now();
        }
        if let Some(Node::File { size: s, .. }) = self.tree.lock().nodes.get_mut(&ino) {
            *s = size;
        }
        self.getattr(ino).await
    }

    async fn write(&self, ino: Ino, offset: u64, data: &[u8]) -> Result<Attr> {
        self.require_writable()?;
        let node = self.node(ino)?;
        let scratch = self.begin_write(ino, &node).await?;
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = std::fs::OpenOptions::new().write(true).open(&scratch)?;
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(data)?;
            file.sync_data()?;
        }
        let size = std::fs::metadata(&scratch)?.len();
        if let Some(entry) = self.pending.lock().await.get_mut(&ino) {
            entry.size = size;
            entry.last_write = std::time::Instant::now();
        }
        if let Some(Node::File {
            size: s, modified, ..
        }) = self.tree.lock().nodes.get_mut(&ino)
        {
            *s = size;
            *modified = Timespec::now().secs;
        }
        self.getattr(ino).await
    }

    async fn create(&self, parent: Ino, name: &[u8], _mode: u32) -> Result<(Ino, Attr)> {
        self.require_writable()?;
        let Node::Dir { document, .. } = self.node(parent)? else {
            return Err(FsError::NotDir);
        };
        let name = String::from_utf8_lossy(name).to_string();
        if self.lookup(parent, name.as_bytes()).await.is_ok() {
            return Err(FsError::Exists);
        }

        // The upload happens on the first flush: a space has no notion of an
        // empty file, and a key cannot be known before there are bytes to hash.
        // Desktop metadata never gets that far — it is recorded as local, and
        // the flush skips it.
        let local = is_local_only(name.as_bytes());
        let ino = {
            let mut tree = self.tree.lock();
            let ino = tree.next_ino;
            tree.next_ino += 1;
            tree.nodes.insert(
                ino,
                Node::File {
                    key: String::new(),
                    name: name.clone(),
                    document,
                    size: 0,
                    modified: Timespec::now().secs,
                },
            );
            if local {
                tree.local.insert(ino, (parent, name.clone().into_bytes()));
            }
            tree.children
                .entry(parent)
                .or_default()
                .push((name.into_bytes(), ino));
            if let Some(Node::Dir { modified, .. }) = tree.nodes.get_mut(&parent) {
                *modified = Timespec::now().secs;
            }
            self.save_identities(&tree)?;
            ino
        };

        let node = self.node(ino)?;
        self.begin_write(ino, &node).await?;
        Ok((ino, self.attr_of(&node, ino)))
    }

    async fn mkdir(&self, _parent: Ino, _name: &[u8], _mode: u32) -> Result<(Ino, Attr)> {
        // A folder here is a document, and creating one from `mkdir` would
        // silently add a document to the space. That belongs in vektor, not in
        // a filesystem shim.
        Err(FsError::Inval)
    }

    async fn symlink(&self, _parent: Ino, _name: &[u8], _target: &[u8]) -> Result<(Ino, Attr)> {
        Err(FsError::Inval)
    }

    async fn remove(&self, parent: Ino, name: &[u8]) -> Result<()> {
        self.require_writable()?;
        let ino = self.lookup(parent, name).await?;
        let node = self.node(ino)?;
        let Node::File { key, .. } = &node else {
            // Removing a folder would mean deleting a document.
            return Err(FsError::Inval);
        };

        if let Some(entry) = self.pending.lock().await.remove(&ino) {
            let _ = std::fs::remove_file(&entry.scratch);
        }
        // A file held back from the space has no object to delete, and its
        // key is empty anyway.
        if !key.is_empty() {
            self.delete_key(key).await?;
        }

        let mut tree = self.tree.lock();
        tree.local.remove(&ino);
        tree.nodes.remove(&ino);
        tree.by_path.retain(|_, mapped| *mapped != ino);
        if !key.is_empty() {
            let identity = format!("upload:{key}");
            if tree.by_identity.get(&identity) == Some(&ino) {
                tree.by_identity.remove(&identity);
            }
        }
        if let Some(entries) = tree.children.get_mut(&parent) {
            entries.retain(|(_, child)| *child != ino);
        }
        if let Some(Node::Dir { modified, .. }) = tree.nodes.get_mut(&parent) {
            *modified = Timespec::now().secs;
        }
        tree.fetched = None;
        self.save_identities(&tree)?;
        Ok(())
    }

    async fn rename(
        &self,
        from_parent: Ino,
        from_name: &[u8],
        to_parent: Ino,
        to_name: &[u8],
    ) -> Result<()> {
        self.require_writable()?;
        if from_parent != to_parent {
            // Folders are documents, and a space deliberately refuses to move
            // an upload between them: the document's ACL is what serves the
            // file, so re-parenting it would change who can read it.
            return Err(FsError::Inval);
        }
        let ino = self.lookup(from_parent, from_name).await?;
        let to_name = String::from_utf8_lossy(to_name).to_string();

        // Which side of the space the file belongs on is decided by the name it
        // ends up with, so a rename can move it either way: an editor that
        // saves through a temporary file renames onto the real name, and the
        // desktop renames onto its own metadata names just as readily.
        let was_local = self.tree.lock().local.contains_key(&ino);
        let now_local = is_local_only(to_name.as_bytes());
        if now_local && !was_local {
            // It is becoming local: pull the bytes down before the object that
            // holds them is deleted, so reads keep working from the scratch
            // file.
            let node = self.node(ino)?;
            self.begin_write(ino, &node).await?;
            if let Node::File { key, .. } = &node
                && !key.is_empty()
            {
                self.delete_key(key).await?;
                let mut tree = self.tree.lock();
                tree.by_identity.remove(&format!("upload:{key}"));
                if let Some(Node::File { key, .. }) = tree.nodes.get_mut(&ino) {
                    key.clear();
                }
                self.save_identities(&tree)?;
            }
        }

        // Re-uploading the same bytes under the new name lands on the same
        // content hash, where the server updates the name in place.
        {
            let mut tree = self.tree.lock();
            if now_local {
                tree.local.insert(ino, (to_parent, to_name.clone().into_bytes()));
            } else {
                tree.local.remove(&ino);
            }
            let parent_path = tree
                .by_path
                .iter()
                .find_map(|(path, mapped)| (*mapped == from_parent).then(|| path.clone()))
                .unwrap_or_default();
            let old_path = if parent_path.is_empty() {
                String::from_utf8_lossy(from_name).to_string()
            } else {
                format!("{parent_path}/{}", String::from_utf8_lossy(from_name))
            };
            let new_path = if parent_path.is_empty() {
                to_name.clone()
            } else {
                format!("{parent_path}/{to_name}")
            };
            tree.by_path.remove(&old_path);
            tree.by_path.insert(new_path, ino);
            if let Some(Node::File { name, .. }) = tree.nodes.get_mut(&ino) {
                *name = to_name.clone();
            }
            if let Some(entries) = tree.children.get_mut(&from_parent) {
                for entry in entries.iter_mut() {
                    if entry.1 == ino {
                        entry.0 = to_name.clone().into_bytes();
                    }
                }
            }
            if let Some(Node::Dir { modified, .. }) = tree.nodes.get_mut(&from_parent) {
                *modified = Timespec::now().secs;
            }
        }

        let node = self.node(ino)?;
        self.begin_write(ino, &node).await?;
        self.flush_pending(true).await
    }

    async fn sync(&self) -> Result<()> {
        self.flush_pending(true).await
    }

    async fn maybe_checkpoint(&self) -> Result<()> {
        self.flush_pending(false).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_names_get_a_suffix() {
        let mut used = HashMap::new();
        assert_eq!(disambiguate(&mut used, "a.png"), "a.png");
        assert_eq!(disambiguate(&mut used, "a.png"), "a (2).png");
        assert_eq!(disambiguate(&mut used, "a.png"), "a (3).png");
        assert_eq!(disambiguate(&mut used, "README"), "README");
        assert_eq!(disambiguate(&mut used, "README"), "README (2)");
    }

    #[test]
    fn unnamed_files_get_a_readable_stand_in() {
        assert_eq!(
            short_name("e9/e9392043845e92f59b15ffd689a2f8227230dc8490cb126e268967c47c34e87c.png"),
            "e939204384.png"
        );
        assert_eq!(short_name("ab/abcdef"), "abcdef");
        // A name shorter than the truncation point is left alone.
        assert_eq!(short_name("no-slash.txt"), "no-slash.txt");
    }

    #[test]
    fn desktop_metadata_is_kept_off_the_space() {
        for name in [
            ".DS_Store",
            "._track#34.wav",
            "._.DS_Store",
            "._lfs-write-test",
            ".Spotlight-V100",
            ".Trashes",
            ".fseventsd",
            ".TemporaryItems",
            ".DocumentRevisions-V100",
            ".localized",
            ".apdisk",
            ".VolumeIcon.icns",
            ".com.apple.timemachine.donotpresent",
            "Thumbs.db",
            "desktop.ini",
            "Icon\r",
        ] {
            assert!(is_local_only(name.as_bytes()), "{name} should be held back");
        }
    }

    #[test]
    fn real_files_still_reach_the_space() {
        for name in [
            "track#34.wav",
            "notes.pdf",
            ".gitignore",
            ".env",
            "_underscore.txt",
            "DS_Store",
            "Icon",
            "icons.svg",
            ".hidden-but-mine",
        ] {
            assert!(!is_local_only(name.as_bytes()), "{name} should be uploaded");
        }
    }

    #[test]
    fn a_name_that_is_not_utf8_is_left_alone() {
        assert!(!is_local_only(&[0xff, 0xfe]));
    }

    #[test]
    fn timestamps_parse_to_epoch_seconds() {
        // 2026-08-29T08:56:20Z
        assert_eq!(
            parse_timestamp(Some("2026-08-29T08:56:20.012Z")),
            1787993780
        );
        assert_eq!(parse_timestamp(Some("1970-01-01T00:00:00Z")), 0);
        assert_eq!(parse_timestamp(None), 0);
        assert_eq!(parse_timestamp(Some("nonsense")), 0);
    }
}

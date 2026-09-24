//! Vektor spaces mounted as volumes through lfs, whose NFS server runs inside this process.
//!
//! App-wide rather than per window: a live mount must outlive any window, and be unmounted
//! before the process exits, or every access to it hangs.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::{StreamExt, channel::mpsc};
use gpui::{App, Global};
use lfs::client::local::LocalMount;
use lfs::fs::vektor::VektorSpace;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::keychain;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountConfig {
    pub origin: String,
    pub space_id: String,
    pub space_slug: String,
    pub writable: bool,
    /// The access token minted for this mount, revoked when the mount is removed.
    pub token_id: Option<String>,
}

/// A token of a removed mount, kept until the web UI confirms it deleted it on the server.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub origin: String,
    pub token_id: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum MountStatus {
    Mounting,
    Mounted {
        path: String,
        /// Why the last unmount did not go through, e.g. a file is still open.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Unmounting,
    /// No access token is stored for this space yet; the web UI mints one.
    NeedsCredentials,
    Failed {
        error: String,
    },
}

/// The `vektor-app:mounts` event's payload.
#[derive(Serialize)]
pub struct MountsPayload {
    pub mounts: Vec<MountState>,
    /// Token ids the web UI should delete, then confirm with `tokenRevoked`.
    pub revoke: Vec<String>,
    /// A failure that belongs to no mount anymore, e.g. cleaning up a removed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the web UI sees of a mount.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountState {
    pub space_id: String,
    pub space_slug: String,
    pub writable: bool,
    #[serde(flatten)]
    pub status: MountStatus,
}

pub struct Entry {
    pub config: MountConfig,
    pub status: MountStatus,
}

/// Outcomes of work done on the tokio runtime, applied back on the main thread.
pub enum MountResult {
    Mounted(String, String),
    NeedsCredentials(String),
    Failed(String, String),
    Unmounted(String),
    UnmountFailed(String, String, String),
    /// The mount is gone, but its keychain item could not be deleted.
    CleanupFailed(String, String),
}

pub struct Mounts {
    pub runtime: tokio::runtime::Runtime,
    /// The Vektor instance this app talks to; mounts of other instances are left alone.
    pub origin: String,
    /// `vektor://` for HTTPS, `vektor+http://` spelled out for plain HTTP.
    pub location: String,
    /// By space id.
    pub entries: BTreeMap<String, Entry>,
    /// Live mounts by space id. Tasks register a mount here before reporting it, so quitting
    /// finds every mount even when its result has not been applied yet.
    pub live: Arc<Mutex<HashMap<String, LocalMount>>>,
    /// Across all instances; only this instance's are offered to its pages.
    pub revocations: Vec<Revocation>,
    /// See [`MountsPayload::error`]; cleared by the next mount.
    pub error: Option<String>,
    /// Mount and unmount work in flight, which quitting waits for.
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
    pub results: mpsc::UnboundedSender<MountResult>,
}

impl Global for Mounts {}

fn support_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME is not set"))
        .join("Library/Application Support/Vektor")
}

fn config_path() -> PathBuf {
    support_dir().join("mounts.json")
}

fn revocations_path() -> PathBuf {
    support_dir().join("revocations.json")
}

pub fn mountpoint(config: &MountConfig) -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME is not set"))
        .join("Vektor")
        .join(&config.space_slug)
}

/// Slugs and ids name folders, URLs and keychain items, so anything beyond this charset is refused.
pub fn is_plain_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn load<T: serde::de::DeserializeOwned + Default>(path: PathBuf) -> T {
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .unwrap_or_else(|e| panic!("{} is corrupt: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => T::default(),
        Err(e) => panic!("could not read {}: {e}", path.display()),
    }
}

fn write(path: PathBuf, value: &impl Serialize) {
    std::fs::create_dir_all(support_dir()).expect("could not create the support directory");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(value).expect("state serializes"),
    )
    .unwrap_or_else(|e| panic!("could not write {}: {e}", path.display()));
}

pub fn init(url: &Url, cx: &mut App) {
    let (results, mut receiver) = mpsc::unbounded();
    let origin = url.origin().ascii_serialization();
    let authority = &origin[origin.find("://").expect("origin has a scheme") + 3..];
    let location = match url.scheme() {
        "https" => format!("vektor://{authority}"),
        "http" => format!("vektor+http://{authority}"),
        scheme => panic!("unsupported VEKTOR_URL scheme {scheme}"),
    };
    let mut mounts = Mounts {
        runtime: tokio::runtime::Runtime::new().expect("failed to start tokio runtime"),
        origin,
        location,
        entries: BTreeMap::new(),
        live: Arc::default(),
        revocations: load(revocations_path()),
        error: None,
        tasks: Vec::new(),
        results,
    };
    for config in load::<Vec<MountConfig>>(config_path()) {
        if config.origin == mounts.origin {
            mounts.mount(config, None);
        }
    }
    cx.set_global(mounts);

    cx.spawn(async move |cx| {
        while let Some(result) = receiver.next().await {
            if cx
                .update_global::<Mounts, _>(|mounts, _| mounts.apply(result))
                .is_err()
            {
                break;
            }
        }
    })
    .detach();

    cx.on_app_quit(|cx| {
        // gpui gives quit handlers only a moment, too little to flush writes, so this blocks.
        cx.global_mut::<Mounts>().unmount_all();
        async {}
    })
    .detach();
}

impl Mounts {
    /// `token` is stored in the keychain first when given; otherwise the stored one is used.
    pub fn mount(&mut self, mut config: MountConfig, token: Option<String>) {
        assert!(is_plain_name(&config.space_id) && is_plain_name(&config.space_slug));
        if self.is_busy(&config.space_id) {
            return;
        }
        self.error = None;
        if let Some(previous) = self.entries.get(&config.space_id) {
            let previous = previous.config.token_id.clone();
            if token.is_none() {
                // Still mounting with the stored token, whose id is only known from before.
                config.token_id = previous;
            } else if previous != config.token_id {
                // A new token replaces the one minted earlier for this space.
                self.revoke(previous);
            }
        }
        let space_id = config.space_id.clone();
        let account = keychain::account(&self.origin, &space_id);
        let location = format!("{}/{}", self.location, config.space_slug);
        let state = lfs::fs::state_dir(&support_dir().join("lfs"), &location);
        let mountpoint = mountpoint(&config);
        let writable = config.writable;
        let results = self.results.clone();
        let live = self.live.clone();

        self.entries.insert(
            space_id.clone(),
            Entry {
                config,
                status: MountStatus::Mounting,
            },
        );
        self.save();

        self.spawn(async move {
            let result = async {
                if let Some(token) = token {
                    keychain::store(&account, &token)?;
                }
                let Some(token) = keychain::read(&account)? else {
                    return Ok(None);
                };
                let volume = VektorSpace::open(&location, &state, writable, Some(token))
                    .await
                    .map_err(|e| e.to_string())?;
                LocalMount::start(volume, &mountpoint, 0)
                    .await
                    .map(Some)
                    .map_err(|e| e.to_string())
            }
            .await;
            let _ = results.unbounded_send(match result {
                Ok(Some(mount)) => {
                    let path = mount.mountpoint.display().to_string();
                    live.lock().unwrap().insert(space_id.clone(), mount);
                    MountResult::Mounted(space_id, path)
                }
                Ok(None) => MountResult::NeedsCredentials(space_id),
                Err(error) => MountResult::Failed(space_id, error),
            });
        });
    }

    /// Stops remembering the space too, so it is not restored on the next launch.
    pub fn unmount(&mut self, space_id: &str) {
        let Some(mount) = self.live.lock().unwrap().remove(space_id) else {
            // Nothing is mounted (failed, or waiting for credentials); work in flight is left
            // to finish and can be unmounted then.
            if !self.is_busy(space_id) {
                self.remove(space_id);
            }
            return;
        };
        self.entries
            .get_mut(space_id)
            .expect("unknown space")
            .status = MountStatus::Unmounting;
        let space_id = space_id.to_string();
        let results = self.results.clone();
        let live = self.live.clone();
        self.spawn(async move {
            let result = match mount.unmount(false).await {
                Ok(()) => {
                    // Only removes the folder if it is empty, i.e. still the bare mountpoint.
                    let _ = std::fs::remove_dir(&mount.mountpoint);
                    match mount.shutdown().await {
                        Ok(()) => MountResult::Unmounted(space_id),
                        Err(e) => MountResult::Failed(space_id, e.to_string()),
                    }
                }
                // Still mounted and served, e.g. because a file is open.
                Err(e) => {
                    let path = mount.mountpoint.display().to_string();
                    live.lock().unwrap().insert(space_id.clone(), mount);
                    MountResult::UnmountFailed(space_id, path, e.to_string())
                }
            };
            let _ = results.unbounded_send(result);
        });
    }

    pub fn is_busy(&self, space_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(space_id)
            || self.entries.get(space_id).is_some_and(|entry| {
                matches!(
                    entry.status,
                    MountStatus::Mounting | MountStatus::Unmounting
                )
            })
    }

    pub fn spawn(&mut self, task: impl Future<Output = ()> + Send + 'static) {
        self.tasks.retain(|task| !task.is_finished());
        self.tasks.push(self.runtime.spawn(task));
    }

    pub fn apply(&mut self, result: MountResult) {
        match result {
            MountResult::Mounted(space_id, path) => {
                self.entries
                    .get_mut(&space_id)
                    .expect("unknown space")
                    .status = MountStatus::Mounted { path, error: None };
            }
            MountResult::NeedsCredentials(space_id) => {
                self.entries
                    .get_mut(&space_id)
                    .expect("unknown space")
                    .status = MountStatus::NeedsCredentials;
            }
            MountResult::Failed(space_id, error) => {
                self.entries
                    .get_mut(&space_id)
                    .expect("unknown space")
                    .status = MountStatus::Failed { error };
            }
            MountResult::Unmounted(space_id) => self.remove(&space_id),
            MountResult::CleanupFailed(space_id, error) => {
                self.error = Some(format!("{space_id}: {error}"));
            }
            MountResult::UnmountFailed(space_id, path, error) => {
                self.entries
                    .get_mut(&space_id)
                    .expect("unknown space")
                    .status = MountStatus::Mounted {
                    path,
                    error: Some(error),
                };
            }
        }
    }

    /// Forced, because the server goes away with this process either way. Entries stay saved,
    /// so they come back on the next launch.
    pub fn unmount_all(&mut self) {
        let tasks = std::mem::take(&mut self.tasks);
        let live = self.live.clone();
        self.runtime.block_on(async {
            for task in tasks {
                let _ = task.await;
            }
            let mounts: Vec<LocalMount> = live.lock().unwrap().drain().map(|(_, m)| m).collect();
            for mount in mounts {
                if let Err(e) = mount.unmount(true).await {
                    eprintln!("unmounting {} failed: {e}", mount.mountpoint.display());
                }
                if let Err(e) = mount.shutdown().await {
                    eprintln!("flushing a mount failed: {e}");
                }
            }
        });
    }

    /// Forgets the space and cleans up its credentials: the keychain item now, the server-side
    /// token once the web UI gets to it.
    pub fn remove(&mut self, space_id: &str) {
        let Some(entry) = self.entries.remove(space_id) else {
            return;
        };
        self.save();
        self.revoke(entry.config.token_id);
        let account = keychain::account(&self.origin, space_id);
        let results = self.results.clone();
        let space_id = space_id.to_string();
        self.spawn(async move {
            if let Err(error) = keychain::delete(&account) {
                let _ = results.unbounded_send(MountResult::CleanupFailed(space_id, error));
            }
        });
    }

    pub fn revoke(&mut self, token_id: Option<String>) {
        if let Some(token_id) = token_id {
            self.revocations.push(Revocation {
                origin: self.origin.clone(),
                token_id,
            });
            write(revocations_path(), &self.revocations);
        }
    }

    pub fn revoked(&mut self, token_id: &str) {
        let origin = self.origin.clone();
        self.revocations
            .retain(|r| !(r.origin == origin && r.token_id == token_id));
        write(revocations_path(), &self.revocations);
    }

    pub fn payload(&self) -> MountsPayload {
        MountsPayload {
            mounts: self
                .entries
                .values()
                .map(|entry| MountState {
                    space_id: entry.config.space_id.clone(),
                    space_slug: entry.config.space_slug.clone(),
                    writable: entry.config.writable,
                    status: entry.status.clone(),
                })
                .collect(),
            revoke: self
                .revocations
                .iter()
                .filter(|r| r.origin == self.origin)
                .map(|r| r.token_id.clone())
                .collect(),
            error: self.error.clone(),
        }
    }

    /// Saved alongside other instances' mounts, which this app run does not touch.
    pub fn save(&self) {
        let mut configs: Vec<MountConfig> = load::<Vec<MountConfig>>(config_path())
            .into_iter()
            .filter(|config| config.origin != self.origin)
            .collect();
        configs.extend(self.entries.values().map(|entry| entry.config.clone()));
        write(config_path(), &configs);
    }
}

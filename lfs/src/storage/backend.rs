//! The persistent backing store. This layer knows about objects and prefixes,
//! and nothing else — no inodes, no NFS.

use std::sync::Arc;

use bytes::Bytes;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload};
use url::Url;

use crate::error::{FsError, Result};

/// The rclone settings worth translating. Anything else in an rclone remote
/// describes behaviour of rclone itself rather than how to reach the server.
const RCLONE_KEYS: &[(&str, &str)] = &[
    ("ACCESS_KEY_ID", "aws_access_key_id"),
    ("SECRET_ACCESS_KEY", "aws_secret_access_key"),
    ("SESSION_TOKEN", "aws_session_token"),
    ("ENDPOINT", "aws_endpoint"),
    ("REGION", "aws_region"),
];

/// Object-store configuration gathered from the environment.
///
/// Two conventions are understood:
///
/// * object_store's own `AWS_*` variables;
/// * rclone's `RCLONE_CONFIG_<REMOTE>_*`, which is what a machine already set
///   up with an rclone remote will be carrying.
///
/// The rclone form is translated and applied first, so an explicit `AWS_*`
/// still wins. The remote is named by `LFS_REMOTE`; if that is unset and the
/// environment describes exactly one remote, that one is used.
///
/// Keys the store builder does not recognise are ignored by it, so passing the
/// whole environment through is safe.
pub fn s3_options() -> Vec<(String, String)> {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let mut options: Vec<(String, String)> = Vec::new();

    if let Some(remote) = rclone_remote(&env) {
        let prefix = format!("RCLONE_CONFIG_{}_", remote.to_uppercase());
        for (suffix, target) in RCLONE_KEYS {
            if let Some((_, value)) = env.iter().find(|(k, _)| *k == format!("{prefix}{suffix}")) {
                if value.is_empty() {
                    continue;
                }
                // A plain http endpoint is refused unless it is opted into.
                if *suffix == "ENDPOINT" && value.starts_with("http://") {
                    options.push(("aws_allow_http".into(), "true".into()));
                }
                options.push(((*target).into(), value.clone()));
            }
        }
        if !options.is_empty() {
            tracing::info!("using rclone remote \"{remote}\" for s3 configuration");
        }
    }

    options.extend(env);
    options
}

/// Which rclone remote to use: `LFS_REMOTE` if set, otherwise the only one
/// defined. Guessing between several would silently pick someone's wrong
/// bucket, so ambiguity is reported rather than resolved.
fn rclone_remote(env: &[(String, String)]) -> Option<String> {
    if let Ok(name) = std::env::var("LFS_REMOTE") {
        return Some(name);
    }
    let mut names: Vec<String> = env
        .iter()
        .filter_map(|(key, _)| {
            let rest = key.strip_prefix("RCLONE_CONFIG_")?;
            RCLONE_KEYS
                .iter()
                .find_map(|(suffix, _)| rest.strip_suffix(&format!("_{suffix}")))
                .map(|name| name.to_string())
        })
        .collect();
    names.sort();
    names.dedup();

    match names.len() {
        0 => None,
        1 => names.pop(),
        _ => {
            tracing::warn!(
                "several rclone remotes in the environment ({}); set LFS_REMOTE to choose one",
                names.join(", ")
            );
            None
        }
    }
}

/// One object, as seen when listing.
#[derive(Debug, Clone)]
pub struct ObjectEntry {
    pub name: String,
    pub size: u64,
    /// Last modified, as seconds since the Unix epoch.
    pub modified: u64,
}

#[derive(Clone)]
pub struct Backend {
    store: Arc<dyn ObjectStore>,
    prefix: ObjPath,
    url: String,
}

impl Backend {
    /// Accepts `s3://bucket/volume`, `file:///path/to/volume`, `memory://` and
    /// bare local paths. S3 credentials come from the standard environment
    /// (`AWS_ACCESS_KEY_ID`, `AWS_REGION`, instance metadata, ...).
    pub fn open(location: &str) -> Result<Backend> {
        let url = if location.contains("://") {
            Url::parse(location).map_err(|e| FsError::Backend(e.to_string()))?
        } else {
            let abs = std::path::absolute(location)?;
            std::fs::create_dir_all(&abs)?;
            Url::from_directory_path(&abs)
                .map_err(|_| FsError::Backend(format!("not a usable path: {location}")))?
        };
        let (store, prefix) = object_store::parse_url_opts(&url, s3_options())?;
        Ok(Backend { store: Arc::from(store), prefix, url: url.to_string() })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    fn path(&self, key: &str) -> ObjPath {
        if self.prefix.as_ref().is_empty() {
            ObjPath::from(key)
        } else {
            ObjPath::from(format!("{}/{}", self.prefix.as_ref(), key))
        }
    }

    pub async fn put(&self, key: &str, data: Bytes) -> Result<()> {
        self.store.put(&self.path(key), PutPayload::from(data)).await?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> Result<Bytes> {
        let res = self.store.get(&self.path(key)).await?;
        Ok(res.bytes().await?)
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self.store.head(&self.path(key)).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// One directory level of a prefix: immediate children only.
    ///
    /// Returns `(subdirectories, objects)`, where a subdirectory is a common
    /// prefix — S3 has no directories, so a "directory" is just the set of keys
    /// sharing a prefix up to the next `/`.
    pub async fn list_dir(&self, prefix: &str) -> Result<(Vec<String>, Vec<ObjectEntry>)> {
        let path = self.path(prefix);
        let result = self.store.list_with_delimiter(Some(&path)).await?;

        let strip = |full: &str| -> String {
            let base = self.path(prefix);
            let base = base.as_ref();
            full.strip_prefix(base)
                .unwrap_or(full)
                .trim_start_matches('/')
                .to_string()
        };

        let dirs = result
            .common_prefixes
            .iter()
            .map(|p| strip(p.as_ref()))
            .filter(|name| !name.is_empty())
            .collect();

        let objects = result
            .objects
            .iter()
            .filter_map(|meta| {
                let name = strip(meta.location.as_ref());
                if name.is_empty() {
                    // A key equal to the prefix itself: a directory marker, not
                    // a child.
                    return None;
                }
                Some(ObjectEntry {
                    name,
                    size: meta.size,
                    modified: meta.last_modified.timestamp().max(0) as u64,
                })
            })
            .collect();

        Ok((dirs, objects))
    }

    /// Metadata for one object, or `NotFound`.
    pub async fn head(&self, key: &str) -> Result<ObjectEntry> {
        let meta = self.store.head(&self.path(key)).await?;
        Ok(ObjectEntry {
            name: key.rsplit('/').next().unwrap_or(key).to_string(),
            size: meta.size,
            modified: meta.last_modified.timestamp().max(0) as u64,
        })
    }

    /// Read a byte range without fetching the whole object.
    pub async fn get_range(&self, key: &str, offset: u64, len: u64) -> Result<Bytes> {
        Ok(self.store.get_range(&self.path(key), offset..offset + len).await?)
    }

    /// Server-side copy. S3 has no rename, so a rename is a copy followed by a
    /// delete — not atomic, and paid for by size on the server side rather than
    /// by transferring the bytes back and forth.
    pub async fn copy(&self, from: &str, to: &str) -> Result<()> {
        self.store.copy(&self.path(from), &self.path(to)).await?;
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        match self.store.delete(&self.path(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn finds_a_single_rclone_remote() {
        let e = env(&[
            ("RCLONE_CONFIG_STORAGE_ACCESS_KEY_ID", "key"),
            ("RCLONE_CONFIG_STORAGE_ENDPOINT", "https://s3.example.com"),
            ("PATH", "/usr/bin"),
        ]);
        assert_eq!(rclone_remote(&e).as_deref(), Some("STORAGE"));
    }

    #[test]
    fn refuses_to_guess_between_several_remotes() {
        // Picking one at random would quietly write to the wrong bucket.
        let e = env(&[
            ("RCLONE_CONFIG_STORAGE_ACCESS_KEY_ID", "a"),
            ("RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID", "b"),
        ]);
        assert_eq!(rclone_remote(&e), None);
    }

    #[test]
    fn handles_remote_names_containing_underscores() {
        let e = env(&[("RCLONE_CONFIG_MY_STORE_SECRET_ACCESS_KEY", "s")]);
        assert_eq!(rclone_remote(&e).as_deref(), Some("MY_STORE"));
    }

    #[test]
    fn no_rclone_config_means_no_remote() {
        assert_eq!(rclone_remote(&env(&[("AWS_ACCESS_KEY_ID", "k")])), None);
    }
}

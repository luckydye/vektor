//! Local mode: this process serves a filesystem on loopback and mounts it with
//! the OS's own NFS client, so it is both server and client.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::client::mount::{self, MountTarget};
use crate::error::{FsError, Result};
use crate::fs::FileSystem;
use crate::server;

pub struct LocalMount {
    pub volume: Arc<dyn FileSystem>,
    pub mountpoint: PathBuf,
    /// Finishes only if the NFS server stops on its own.
    pub server: JoinHandle<Result<()>>,
    pub idle_flusher: Option<JoinHandle<()>>,
}

impl LocalMount {
    /// Port 0 picks a free one, so several mounts can run side by side.
    pub async fn start(
        volume: Arc<dyn FileSystem>,
        mountpoint: &Path,
        port: u16,
    ) -> Result<LocalMount> {
        let export = volume.name().to_string();
        let addr = format!("127.0.0.1:{port}");
        let (bound, run) = server::serve(Arc::clone(&volume), &addr, &export).await?;
        let server = tokio::spawn(run);
        let target = MountTarget {
            host: "127.0.0.1".into(),
            port: bound,
            export: format!("/{export}"),
            read_only: !volume.writable(),
        };
        // `mount_nfs` blocks until it has talked to the server above, which
        // needs this runtime to keep serving meanwhile.
        let path = mountpoint.to_path_buf();
        let mounted = tokio::task::spawn_blocking(move || mount::mount(&target, &path))
            .await
            .map_err(|e| FsError::Backend(format!("mount task failed: {e}")))?;
        if let Err(e) = mounted {
            server.abort();
            return Err(e);
        }
        Ok(LocalMount {
            // Same reason as the `serve` path: a file written once and then
            // left alone has no later write to ride along with, and would sit
            // in scratch until unmount.
            idle_flusher: spawn_idle_flusher(&volume),
            volume,
            mountpoint: mountpoint.to_path_buf(),
            server,
        })
    }

    /// Detach the mount. On failure (e.g. a file is still open) it stays
    /// mounted and served, unless `force` is set.
    pub async fn unmount(&self, force: bool) -> Result<()> {
        let path = self.mountpoint.clone();
        tokio::task::spawn_blocking(move || mount::unmount(&path, force))
            .await
            .map_err(|e| FsError::Backend(format!("unmount task failed: {e}")))?
    }

    /// Stop serving and upload what is still buffered. `sync`, not
    /// `maybe_checkpoint`: a write from the last moment is still inside its
    /// idle window, and has already been acknowledged to the client.
    pub async fn shutdown(self) -> Result<()> {
        self.server.abort();
        if let Some(flusher) = self.idle_flusher {
            flusher.abort();
        }
        if self.volume.writable() {
            self.volume.sync().await?;
        }
        Ok(())
    }
}

/// Upload buffered writes once they go quiet.
///
/// A filesystem that buffers acknowledges a write before its bytes leave the
/// machine, and only flushes them after an idle period. Nothing else drives
/// that: a checkpoint runs after each write, but a file written once and then
/// left alone is still inside its idle window at that point, so without a
/// timer it would sit in scratch until the process exits.
///
/// `None` when the mount is read-only, where there is nothing to flush.
pub fn spawn_idle_flusher(volume: &Arc<dyn FileSystem>) -> Option<JoinHandle<()>> {
    if !volume.writable() {
        return None;
    }
    let fs = Arc::clone(volume);
    Some(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            if let Err(e) = fs.maybe_checkpoint().await {
                tracing::error!("background flush failed: {e}");
            }
        }
    }))
}

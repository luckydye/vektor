//! Protocol front ends. Today: NFSv3 over TCP, which every target OS can mount
//! without installing a driver.

pub mod nfs;
pub mod smb;

use std::sync::Arc;

use nfsserve::tcp::{NFSTcp, NFSTcpListener};

use crate::error::{FsError, Result};
use crate::fs::FileSystem;

/// Bind an NFS server to `addr` and serve `volume` under `/export_name`.
/// Returns the port actually bound, plus a future that runs the server.
pub async fn serve(
    volume: Arc<dyn FileSystem>,
    addr: &str,
    export_name: &str,
) -> Result<(u16, impl std::future::Future<Output = Result<()>> + Send + use<>)> {
    let mut listener = NFSTcpListener::bind(addr, nfs::NfsAdapter::new(volume))
        .await
        .map_err(FsError::Io)?;
    listener.with_export_name(export_name);
    let port = listener.get_listen_port();
    Ok((port, async move { listener.handle_forever().await.map_err(FsError::Io) }))
}

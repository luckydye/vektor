//! The single binary: server, client, and local mode.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use lfs::client::mount::{self, MountTarget};
use lfs::fs::{passthrough::Passthrough, vektor::VektorSpace, FileSystem, Volume};
use lfs::server::smb::Credentials;
use lfs::{server, Result};

const DEFAULT_PORT: u16 = 12000;
/// The port Windows and macOS SMB clients assume. Binding it needs privilege.
const DEFAULT_SMB_PORT: u16 = 445;

#[derive(Parser)]
#[command(name = "lfs", version, about = "WAL-backed filesystem on object storage")]
struct Cli {
    /// Local state directory (WAL + chunk cache). Defaults to ~/.lfs/<volume>.
    #[arg(long, global = true)]
    state: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Host a volume over NFS, SMB, or both.
    Serve {
        /// s3://bucket/volume, vektor://host/space (or vektor+http:// for a
        /// local instance), file:///path, memory://, or a local path.
        backend: String,
        #[arg(long, default_value = "127.0.0.1")]
        listen: String,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        /// Volume name, used as the NFS export and SMB share. Defaults to the
        /// last component of the backing location.
        #[arg(long, alias = "export")]
        name: Option<String>,
        /// Hostname to print in mount instructions. Defaults to --listen.
        #[arg(long)]
        hostname: Option<String>,
        /// Seconds between background checkpoints to the object store.
        #[arg(long, default_value_t = 30)]
        checkpoint_interval: u64,

        /// Also serve SMB, which is what Windows mounts natively.
        #[arg(long)]
        smb: bool,
        /// SMB port. 445 is what clients assume, and binding it needs root.
        #[arg(long, default_value_t = DEFAULT_SMB_PORT)]
        smb_port: u16,
        /// SMB user. Windows refuses guest access by default, so SMB always
        /// authenticates.
        #[arg(long, default_value = "lfs")]
        smb_user: String,
        /// SMB password. Falls back to the LFS_SMB_PASSWORD environment
        /// variable, which keeps it out of the process list.
        #[arg(long)]
        smb_password: Option<String>,
        /// Serve only SMB, not NFS.
        #[arg(long)]
        smb_only: bool,

        /// Present objects already in the bucket as files, instead of serving
        /// an lfs volume stored there.
        #[arg(long)]
        browse: bool,
        /// Allow writes for a browse or vektor mount. Off by default: both
        /// point at data this program did not create, and a write replaces a
        /// whole object.
        #[arg(long)]
        writable: bool,
    },

    /// Mount a volume. Either a remote server (host:/export) or a backend URL,
    /// in which case a server is started in-process on loopback.
    Mount {
        target: String,
        mountpoint: PathBuf,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        /// Allow writes when mounting a Vektor space directly.
        #[arg(long)]
        writable: bool,
    },

    /// Unmount a mountpoint.
    Unmount { mountpoint: PathBuf },

    /// Show recovery state for a volume without serving it.
    Status { backend: String },

    /// Force a checkpoint to the object store and exit.
    Checkpoint { backend: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("LFS_LOG")
                .unwrap_or_else(|_| "lfs=info,nfsserve=warn".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            backend,
            listen,
            port,
            name,
            hostname,
            checkpoint_interval,
            smb,
            smb_port,
            smb_user,
            smb_password,
            smb_only,
            browse,
            writable,
        } => {
            // Two different filesystems can sit behind the same front ends.
            let (volume, flusher): (Arc<dyn FileSystem>, Option<_>) = if backend
                .starts_with("vektor://") || backend.starts_with("vektor+http://")
            {
                // A vektor space is named by its own URL, so it needs no flag.
                let state = cli
                    .state
                    .clone()
                    .unwrap_or_else(|| default_state_dir(&backend));
                let fs = VektorSpace::open(&backend, &state, writable).await?;
                println!(
                    "serving a vektor space's uploads ({})",
                    if writable { "read-write" } else { "read-only" }
                );
                (fs, None)
            } else if browse {
                let scratch = cli
                    .state
                    .clone()
                    .unwrap_or_else(|| default_state_dir(&backend))
                    .join("scratch");
                let fs = Passthrough::open(&backend, &scratch, writable).await?;
                println!(
                    "browsing existing objects ({})",
                    if writable { "read-write" } else { "read-only" }
                );
                (fs, None)
            } else {
                let v = open(&backend, cli.state.as_deref()).await?;
                let flusher = v.spawn_flusher(Duration::from_secs(checkpoint_interval));
                (v, Some(flusher))
            };
            let _flusher = flusher;

            let export = name.unwrap_or_else(|| volume.name().to_string());
            // Mount instructions have to name something a client can resolve;
            // the bind address may be a wildcard, which is useless in a path.
            let host = hostname.unwrap_or_else(|| match listen.as_str() {
                "0.0.0.0" | "::" | "[::]" => "localhost".to_string(),
                other => other.to_string(),
            });
            let access = if volume.writable() { "read-write" } else { "read-only" };
            println!("volume \"{export}\" on {} ({access})", volume.location());

            let nfs = if smb_only {
                None
            } else {
                let addr = format!("{listen}:{port}");
                let (bound, run) = server::serve(Arc::clone(&volume), &addr, &export).await?;
                println!("  nfs  {host}:{bound}/{export}");
                // Spell out the mount so a read-only volume is mounted `ro`;
                // a client that mounts it read-write presents it as writable
                // and only finds out on the first save.
                let ro = if volume.writable() { "" } else { ",ro" };
                println!(
                    "       mount -t nfs -o nolocks,locallocks,vers=3,tcp,port={bound},mountport={bound},hard,rsize=1048576,wsize=1048576,noresvport{ro} {host}:/{export} <mountpoint>"
                );
                Some(tokio::spawn(run))
            };

            let smb_task = if smb || smb_only {
                let password = smb_password
                    .or_else(|| std::env::var("LFS_SMB_PASSWORD").ok())
                    .unwrap_or_else(|| {
                        eprintln!("no --smb-password or LFS_SMB_PASSWORD set; using 'lfs'");
                        "lfs".to_string()
                    });
                let creds = Credentials {
                    user: smb_user.clone(),
                    password,
                    domain: "LFS".to_string(),
                };
                let addr = format!("{listen}:{smb_port}");
                let (bound, run) =
                    server::smb::serve_smb(Arc::clone(&volume), &addr, export.clone(), creds)
                        .await?;
                println!("  smb  \\\\{host}\\{export} (port {bound}, user {smb_user})");
                if bound == 445 {
                    println!("       net use Z: \\\\{host}\\{export} /user:{smb_user}");
                } else {
                    println!("       mount_smbfs //{smb_user}@{host}:{bound}/{export} <mountpoint>");
                    if !volume.writable() {
                        println!("       (read-only: the share reports no write access)");
                    }
                    println!("       (Windows requires port 445, which needs privilege to bind)");
                }
                Some(tokio::spawn(run))
            } else {
                None
            };

            if nfs.is_none() && smb_task.is_none() {
                return Err(lfs::FsError::Backend("no protocol enabled".into()));
            }

            let _idle = spawn_idle_flusher(&volume);

            tokio::select! {
                Some(r) = optional(nfs) => r?,
                Some(r) = optional(smb_task) => r?,
                _ = shutdown_signal() => {
                    if volume.writable() {
                        println!("\nflushing before exit...");
                        // `sync`, not `maybe_checkpoint`: buffered writes have
                        // already been acknowledged and must not be dropped
                        // because they were still within their idle window.
                        volume.sync().await?;
                    }
                }
            }
            Ok(())
        }

        Command::Mount { target, mountpoint, port, writable } => {
            if target.contains("://") || std::path::Path::new(&target).is_dir() {
                // Local mode: this process is both server and client.
                let (volume, flusher): (Arc<dyn FileSystem>, Option<_>) = if target
                    .starts_with("vektor://") || target.starts_with("vektor+http://")
                {
                    let state = cli
                        .state
                        .clone()
                        .unwrap_or_else(|| default_state_dir(&target));
                    (VektorSpace::open(&target, &state, writable).await?, None)
                } else {
                    let v = open(&target, cli.state.as_deref()).await?;
                    let flusher = v.spawn_flusher(Duration::from_secs(30));
                    (v, Some(flusher))
                };
                let _flusher = flusher;
                // Same reason as the `serve` path: a file written once and then
                // left alone has no later write to ride along with, and would
                // sit in scratch until unmount.
                let _idle = spawn_idle_flusher(&volume);
                let export = volume.name().to_string();
                let addr = format!("127.0.0.1:{port}");
                let (bound, run) = server::serve(Arc::clone(&volume), &addr, &export).await?;
                let server = tokio::spawn(run);

                let t = MountTarget {
                    host: "127.0.0.1".into(),
                    port: bound,
                    export: format!("/{export}"),
                    read_only: !volume.writable(),
                };
                mount::mount(&t, &mountpoint)?;
                println!("mounted {} at {}", volume.location(), mountpoint.display());
                println!("press ctrl-c to unmount");

                tokio::select! {
                    _ = server => {}
                    _ = shutdown_signal() => {}
                }
                let _ = mount::unmount(&mountpoint);
                if volume.writable() {
                    // `sync`, not `maybe_checkpoint`: a write from the last
                    // moment before shutdown is still inside its idle window,
                    // and has already been acknowledged to the client.
                    volume.sync().await?;
                }
                println!("unmounted");
                Ok(())
            } else {
                let t = MountTarget::parse(&target, port)?;
                mount::mount(&t, &mountpoint)?;
                println!("mounted {}:{} at {}", t.host, t.export, mountpoint.display());
                Ok(())
            }
        }

        Command::Unmount { mountpoint } => {
            mount::unmount(&mountpoint)?;
            println!("unmounted {}", mountpoint.display());
            Ok(())
        }

        Command::Status { backend } => {
            let volume = open(&backend, cli.state.as_deref()).await?;
            let s = volume.stats().await;
            println!("backend:       {}", volume.backend_url());
            println!("state dir:     {}", volume.state_dir().display());
            println!("inodes:        {}", s.inodes);
            println!("wal bytes:     {}", s.wal_bytes);
            println!("dirty chunks:  {}", s.dirty_chunks);
            Ok(())
        }

        Command::Checkpoint { backend } => {
            let volume = open(&backend, cli.state.as_deref()).await?;
            let epoch = volume.checkpoint().await?;
            println!("checkpointed at epoch {epoch}");
            Ok(())
        }
    }
}

/// Await a task that may not have been started, without letting a `None` arm
/// win the select immediately.
async fn optional(task: Option<tokio::task::JoinHandle<Result<()>>>) -> Option<Result<()>> {
    match task {
        Some(handle) => handle.await.ok(),
        None => std::future::pending().await,
    }
}

/// SIGTERM is what launchd and service managers send; Ctrl-C is what an
/// interactive process receives. Both must take the graceful unmount path.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.expect("install Ctrl-C handler");
}

async fn open(backend: &str, state: Option<&std::path::Path>) -> Result<Arc<Volume>> {
    let dir = match state {
        Some(p) => p.to_path_buf(),
        None => default_state_dir(backend),
    };
    Volume::open(backend, &dir).await
}

/// One state directory per backend URL, so several volumes can be served from
/// the same machine without sharing a WAL.
///
/// Hidden, because a WAL and a chunk cache are this program's business rather
/// than the user's. Named for the volume with a hash suffix, so the directory
/// says which volume it belongs to while two volumes of the same name in
/// different buckets still get their own.
/// Upload buffered writes once they go quiet.
///
/// A filesystem that buffers acknowledges a write before its bytes leave the
/// machine, and only flushes them after an idle period. Nothing else drives
/// that: a checkpoint runs after each write, but a file written once and then
/// left alone is still inside its idle window at that point, so without a
/// timer it would sit in scratch until the process exits.
///
/// `None` when the mount is read-only, where there is nothing to flush.
fn spawn_idle_flusher(volume: &Arc<dyn FileSystem>) -> Option<tokio::task::JoinHandle<()>> {
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

fn default_state_dir(backend: &str) -> PathBuf {
    let tag = &blake3::hash(backend.as_bytes()).to_hex()[..8];
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    home.join(".lfs").join(format!("{}-{tag}", volume_name_of(backend)))
}

fn volume_name_of(backend: &str) -> String {
    lfs::fs::volume_name(backend)
}

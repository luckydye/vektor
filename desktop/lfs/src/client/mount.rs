//! Native mount/unmount, per platform.

use std::path::Path;
use std::process::Command;

use crate::error::{FsError, Result};

/// Where a server address and export are combined into something the OS's
/// mount command understands.
pub struct MountTarget {
    pub host: String,
    pub port: u16,
    pub export: String,
    /// Mount without write permission. Set for a filesystem that would refuse
    /// writes anyway, so the refusal happens in the client rather than after a
    /// round trip.
    pub read_only: bool,
}

impl MountTarget {
    /// Parse `host:/export`, `host:port:/export`, or `/export` (implying loopback).
    pub fn parse(spec: &str, default_port: u16) -> Result<MountTarget> {
        if let Some(export) = spec.strip_prefix('/') {
            return Ok(MountTarget {
                host: "127.0.0.1".into(),
                port: default_port,
                export: format!("/{export}"),
                read_only: false,
            });
        }
        let (hostpart, export) = spec
            .split_once(":/")
            .ok_or_else(|| FsError::Backend(format!("expected host:/export, got {spec}")))?;
        let (host, port) = match hostpart.rsplit_once(':') {
            Some((h, p)) => (
                h.to_string(),
                p.parse().map_err(|_| FsError::Backend(format!("bad port in {spec}")))?,
            ),
            None => (hostpart.to_string(), default_port),
        };
        Ok(MountTarget { host, port, export: format!("/{export}"), read_only: false })
    }
}

pub fn mount(target: &MountTarget, mountpoint: &Path) -> Result<()> {
    std::fs::create_dir_all(mountpoint)?;
    let spec = format!("{}:{}", target.host, target.export);
    // A filesystem that refuses writes is mounted read-only, so the client
    // shows it as locked and refuses locally. Without this the mount looks
    // writable and a save fails only after the user has done the work.
    let ro = if target.read_only { ",ro" } else { "" };

    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("/sbin/mount_nfs");
        c.arg("-o").arg(format!(
            // `nolocks`/`locallocks` because the server speaks no NLM; `noresvport`
            // so mounting does not need a privileged source port.
            "nolocks,locallocks,vers=3,tcp,port={p},mountport={p},hard,rsize=1048576,wsize=1048576,noresvport{ro}",
            p = target.port
        ));
        c.arg(&spec).arg(mountpoint);
        c
    } else if cfg!(target_os = "linux") {
        let mut c = Command::new("mount");
        c.arg("-t").arg("nfs").arg("-o").arg(format!(
            "nolock,vers=3,tcp,port={p},mountport={p},hard,rsize=1048576,wsize=1048576{ro}",
            p = target.port
        ));
        c.arg(&spec).arg(mountpoint);
        c
    } else if cfg!(target_os = "windows") {
        // Windows' built-in NFS client always talks to port 111/2049 and ships
        // only with some editions; see `docs/platforms.md`.
        let mut c = Command::new("mount");
        c.arg("-o").arg(if target.read_only { "anon,nolock,ro" } else { "anon,nolock" });
        c.arg(format!("\\\\{}\\{}", target.host, target.export.trim_start_matches('/')));
        c.arg(mountpoint);
        c
    } else {
        return Err(FsError::Backend("unsupported platform for native mount".into()));
    };

    run(&mut cmd, "mount")
}

/// `force` detaches even while files are open, which is what a server about to
/// exit needs: a hard NFS mount left without its server hangs every access.
pub fn unmount(mountpoint: &Path, force: bool) -> Result<()> {
    let mut cmd = Command::new("umount");
    if force || cfg!(target_os = "windows") {
        cmd.arg("-f");
    }
    cmd.arg(mountpoint);
    run(&mut cmd, "umount")
}

fn run(cmd: &mut Command, what: &str) -> Result<()> {
    let out = cmd.output().map_err(|e| {
        FsError::Backend(format!("could not run {what}: {e}"))
    })?;
    if out.status.success() {
        Ok(())
    } else {
        Err(FsError::Backend(format!(
            "{what} failed: {}{}",
            String::from_utf8_lossy(&out.stderr).trim(),
            String::from_utf8_lossy(&out.stdout).trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mount_specs() {
        let t = MountTarget::parse("server:/volume", 12000).unwrap();
        assert_eq!((t.host.as_str(), t.port, t.export.as_str()), ("server", 12000, "/volume"));

        let t = MountTarget::parse("server:2049:/volume", 12000).unwrap();
        assert_eq!(t.port, 2049);

        let t = MountTarget::parse("/volume", 12000).unwrap();
        assert_eq!(t.host, "127.0.0.1");

        assert!(MountTarget::parse("nonsense", 12000).is_err());
    }
}

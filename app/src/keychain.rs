//! Access tokens for mounted spaces, kept in the login keychain via `security`.

use std::io::Write;
use std::process::{Command, Stdio};

const SERVICE: &str = "Vektor Desktop";

/// One item per instance and space, so tokens for different servers never mix.
pub fn account(origin: &str, space_id: &str) -> String {
    format!("{origin} {space_id}")
}

pub fn read(account: &str) -> Result<Option<String>, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
        .output()
        .map_err(|e| format!("could not run security: {e}"))?;
    match output.status.code() {
        Some(0) => Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        )),
        // errSecItemNotFound
        Some(44) => Ok(None),
        _ => Err(format!(
            "keychain lookup failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

/// The command goes over stdin (`security -i`), so the token never shows up in the process list.
pub fn store(account: &str, token: &str) -> Result<(), String> {
    let safe = |value: &str| !value.contains(['"', '\\', '\n']);
    if !safe(account) || !safe(token) {
        return Err("refusing to store a value that needs escaping".into());
    }
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run security: {e}"))?;
    writeln!(
        child.stdin.take().expect("stdin is piped"),
        "add-generic-password -U -s \"{SERVICE}\" -a \"{account}\" -w \"{token}\""
    )
    .map_err(|e| format!("could not write to security: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("security failed: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    // `security -i` exits 0 even when a command fails, reporting on stderr instead.
    if !output.status.success() || !stderr.trim().is_empty() {
        return Err(format!("keychain write failed: {}", stderr.trim()));
    }
    Ok(())
}

pub fn delete(account: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", account])
        .output()
        .map_err(|e| format!("could not run security: {e}"))?;
    match output.status.code() {
        // Already gone (errSecItemNotFound) is as good as deleted.
        Some(0) | Some(44) => Ok(()),
        _ => Err(format!(
            "keychain delete failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

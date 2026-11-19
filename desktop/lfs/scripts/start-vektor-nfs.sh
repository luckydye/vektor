#!/usr/bin/env bash
# Serve the Vektor development space over NFS and mount it locally.
#
# Usage:
#   scripts/start-vektor-nfs.sh
#   VEKTOR_ACCESS_TOKEN=at_... scripts/start-vektor-nfs.sh
#
# Optional overrides:
#   VEKTOR_URL          (default: vektor://app.vektorapp.org/vektor-dev)
#   VEKTOR_MOUNT_POINT  (default: $HOME/mnt/vektor-dev)
#   LFS_NFS_PORT        (default: 12000)
#   LFS_BIN             (default: $HOME/.local/bin/lfs)

set -euo pipefail

vektor_url="${VEKTOR_URL:-vektor://app.vektorapp.org/vektor-dev}"
mount_point="${VEKTOR_MOUNT_POINT:-${HOME:?}/mnt/vektor-dev}"
nfs_port="${LFS_NFS_PORT:-12000}"
lfs_bin="${LFS_BIN:-${HOME:?}/.local/bin/lfs}"

if [[ ! -x "$lfs_bin" ]]; then
    echo "error: built lfs binary not found at $lfs_bin" >&2
    echo "install the release lfs binary there or set LFS_BIN" >&2
    exit 1
fi

if [[ -z "${VEKTOR_ACCESS_TOKEN:-}" && -z "${VEKTOR_KEYCHAIN_SERVICE:-}" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
        export VEKTOR_KEYCHAIN_SERVICE="org.lfs.vektor-nfs"
    else
        echo "error: VEKTOR_ACCESS_TOKEN is not set" >&2
        exit 2
    fi
fi

exec "$lfs_bin" mount "$vektor_url" "$mount_point" --port "$nfs_port"

# Platform notes

Two protocol front ends, because no single one mounts natively everywhere.

| | NFSv3 | SMB2 |
|---|---|---|
| macOS | yes, unprivileged | yes |
| Linux | yes, needs root | yes (`mount -t cifs`) |
| Windows | optional feature, missing on Home | **yes, every edition** |
| Authentication | none (AUTH_SYS, advisory) | NTLMv2, required |
| Packet signing | none | yes (HMAC-SHA256 / AES-CMAC) |

Serve either or both:

```sh
lfs serve s3://bucket/vol                      # NFS only
lfs serve s3://bucket/vol --smb                # both
lfs serve s3://bucket/vol --smb-only --smb-port 4445
```

## Windows — use SMB

```
net use Z: \\server\volume /user:lfs
```

SMB needs no optional feature, no driver, and no edition check. It does need
credentials: Windows 10 and 11 refuse guest fallback by default
(`AllowInsecureGuestAuth` is 0), so `lfs serve --smb` always authenticates.
Set the password with `--smb-password` or, better, `LFS_SMB_PASSWORD`, which
keeps it out of the process list.

Windows 11 24H2 also requires SMB signing by default. The server signs every
response and verifies signed requests, using HMAC-SHA256 under dialect 2.1 and
AES-CMAC under 3.0.2.

The server binds port 445 by default because that is where clients look.
Binding it needs privilege, and on many machines the local `LanmanServer`
already holds it. `--smb-port` exists for testing; most clients cannot be
pointed at a non-standard port (macOS can, via `//user@host:port/share`).

Windows' NFS client remains an option — it is an optional feature on Pro,
Enterprise, and Server, and it insists on ports 111 and 2049 — but SMB is the
path that works everywhere.

## macOS

NFS, unprivileged:

```sh
mount -t nfs -o nolocks,locallocks,vers=3,tcp,port=P,mountport=P,hard,noresvport 127.0.0.1:/volume ~/mnt
```

`noresvport` is what allows a non-root mount; `nolocks` matters because the NFS
server speaks no NLM.

SMB:

```sh
mount_smbfs "//user:password@127.0.0.1:4445/share" ~/mnt
```

macOS opens with an SMB1 multi-protocol negotiate listing `SMB 2.???`; the
server answers with an SMB2 negotiate carrying the wildcard dialect, and the
client restarts in SMB2. SMB1 is never actually spoken.

macOS writes AppleDouble `._*` sidecars for extended attributes on filesystems
without native xattr support. Harmless, but visible over both protocols.

## Linux

```sh
mount -t nfs  -o nolock,vers=3,tcp,port=P,mountport=P,hard 127.0.0.1:/volume ~/mnt
mount -t cifs -o user=lfs,vers=3.0,port=4445 //127.0.0.1/share ~/mnt
```

Both need `CAP_SYS_ADMIN`. There is no unprivileged equivalent of macOS's
`noresvport`.

## Locking

Neither front end provides cross-client locking. NFS has no NLM/NSM
(`nolocks`/`nolock`), and SMB acknowledges `SMB2_LOCK` without doing anything.
That is fine for a single writer and wrong for concurrent writers across
machines; see the single-writer note in `docs/design.md`.

## Case sensitivity

The engine is case-sensitive and both front ends report it as such. Windows
software that assumes case-insensitive lookup may be surprised — this is the
same caveat as any case-sensitive share.

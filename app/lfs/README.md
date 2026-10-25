# lfs

One cross-platform binary that exposes a WAL-backed filesystem persisted to S3,
and can act as either the server or the client.

```
                    S3
                     │
              ┌──────▼──────┐
              │    lfs     │
              │   server    │   WAL + cache + metadata
              └──┬───────┬──┘
          NFSv3  │       │  SMB2
       ┌─────────┴─┐   ┌─┴──────────┐
     macOS   Linux     Windows  macOS  Linux
```

Two front ends over one engine: NFS where it mounts unprivileged, SMB where it
does not. Windows mounts SMB on every edition; its NFS client is an optional
feature absent from Home. See `docs/platforms.md`.

## Usage

```sh
# Host a volume over NFS
lfs serve s3://bucket/volume --listen 0.0.0.0 --port 12000

# ...or over both NFS and SMB
LFS_SMB_PASSWORD=secret lfs serve s3://bucket/volume --smb --smb-user alice

# Mount it from another machine
lfs mount server:12000:/volume ~/mnt          # NFS
net use Z: \\server\volume /user:alice        # SMB, from Windows

# Or run server and client in one process, straight against the bucket
lfs mount s3://bucket/volume ~/mnt

lfs serve s3://bucket/prefix --browse             # existing objects, as files
lfs serve s3://bucket/prefix --browse --writable  # ...and writable
lfs status s3://bucket/volume      # recovery state without serving
lfs checkpoint s3://bucket/volume  # force a flush to the object store
lfs unmount ~/mnt
```

Backends: `s3://bucket/prefix`, `file:///path`, `memory://`, or a bare local
path (handy for testing without a bucket). S3 credentials come from the usual
environment (`AWS_ACCESS_KEY_ID`, `AWS_REGION`, instance metadata).

Every backend exposes a stable filesystem identity. Regular volumes persist
inode allocation in their metadata and WAL; Vektor and browse mounts keep a
small identity index in the local state directory. Preserve that directory when
applications retain file references across server restarts—deleting it
deliberately creates a new set of file identities.

## Layering

The rule the design is built around: **the storage engine knows nothing about
NFS, and the NFS layer knows nothing about S3.**

| Layer | Module | Knows about |
|---|---|---|
| Protocol | `server::nfs`, `server::smb` | `nfsstat3` / `NTSTATUS` and the engine's API |
| Engine | `fs` | inodes, namespace, chunked read/write |
| Storage | `storage` | WAL, metadata state machine, chunks, cache, object store |

Each front end is pure translation — every protocol type dies at that boundary.
SMB was added as a second front end without touching the engine or the storage
layer, which is the layering doing its job.

## Persistence

```
write ─► WAL append ─► fsync ─► ACK ─► (async) chunks + snapshot ─► S3 ─► WAL cut
```

* **WAL** — a directory of numbered segments; frames are length + CRC32 +
  postcard payload. Replay stops at the first torn frame, which is exactly the
  record a crash never acknowledged.
* **Metadata** — `Op` is the only way state changes, and both the live path and
  replay go through `MetaStore::apply`, so recovery is identical to normal
  operation by construction.
* **Chunks** — 256 KiB, named by their BLAKE3 hash. Immutable and
  content-addressed, so they dedupe for free, cache without invalidation, and
  make snapshots and partial updates cheap.
* **Checkpoint ordering** — chunks become durable before the snapshot that
  names them, and the snapshot before the WAL that produced it is discarded.
  Any other order can resurrect metadata pointing at chunks that do not exist.
* **Group commit** — fsync costs ~4 ms and dominates everything else, so one
  sync is made to cover every batch that reached the log before it started.
  See the performance section of `docs/design.md`.

Segments exist so a checkpoint can seal the log under the lock (cheap) and do
the S3 uploads after releasing it, without blocking writers or losing records
appended meanwhile.

## Status

52 tests. Verified against real macOS NFS *and* SMB mounts: create, read,
write, truncate, rename, mkdir, rmdir, unlink, directory listing with search
patterns, symlinks (NFS), 8 MB binary round-trips, copying a source tree in and
diffing it back, crash recovery from the WAL alone, and cold recovery from the
object store with all local state deleted.

The SMB front end speaks dialects 2.1 and 3.0.2 with NTLMv2 authentication and
packet signing, which is what current Windows requires.

See `docs/design.md` for what is deliberately not built yet.

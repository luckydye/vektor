# Design notes

What exists, what it costs, and what is deliberately missing.

## What is built

* Segmented WAL with CRC-framed records and torn-tail recovery.
* Metadata as a deterministic state machine over an `Op` log; replay and the
  live path share one `apply`.
* Content-addressed 256 KiB chunks with a local cache in front of the object
  store, read-modify-write for partial chunks.
* Checkpoints: seal the log, upload chunks, upload the snapshot, then cut the
  log — in that order.
* NFSv3 front end, and a CLI covering `serve`, `mount`, `unmount`, `status`,
  `checkpoint`.
* SMB2 front end (dialects 2.1 and 3.0.2): NTLMv2 authentication, packet
  signing, compound request chains, the SMB1-to-SMB2 negotiate upgrade, and the
  file and filesystem information classes clients actually ask for.

## Performance

One number governs write throughput: **fsync costs ~4 ms** on a typical APFS
volume. Everything else the write path does is an order of magnitude cheaper —
0.8 ms to write a 256 KiB chunk, 0.11 ms to hash it.

So the only question that matters is how many writes share one fsync. The
engine uses **group commit**: a writer appends its batch to the log, then waits
on a sync, and whichever task performs that sync covers every batch that
reached the log before it started. One fsync can therefore retire dozens of
writes.

Making that pay off required the write path to release the global lock during
chunk I/O, so a writer can build its chunks while another is stuck in fsync.
Read-modify-write is instead serialised per inode, which is the narrowest lock
that still prevents two writes to one chunk rebuilding it from the same stale
base.

64 MiB through the engine, 128 KiB writes:

| writers | throughput |
|---|---|
| 1 | 31 MB/s |
| 2 | 43 MB/s |
| 4 | 72 MB/s |
| 8 | 130 MB/s |
| 16 | 233 MB/s |

A genuinely serial single writer is still one fsync per write and cannot be
faster without weakening the durability promise. In practice both NFS and SMB
clients keep several writes outstanding, so real mounts land at the batched end:
242 MB/s for a single `dd` over NFS with 128 KiB blocks.

Two things would help further and are not done:

* **Sub-chunk writes still amplify.** A 128 KiB write into a 256 KiB chunk
  reads, rebuilds, and rewrites the whole chunk. Buffering dirty chunks in
  memory and materialising them on eviction would remove it.
* **NFSv3 UNSTABLE writes.** The protocol lets a client say "no need to make
  this durable yet" and send COMMIT later, which is exactly the escape from
  fsync-per-write. `nfsserve` answers `FILE_SYNC` unconditionally and does not
  surface the client's requested stability to the VFS, so taking this route
  means patching that crate.

## Writing through a browse mount

`--browse --writable` makes an object store writable, on different terms from a
volume, and the difference is not hideable:

* An object is written whole, so a write is buffered into a local scratch file
  and the entire object is uploaded once the file has been idle ~1.5s. A stream
  of writes coalesces into one upload; appending repeatedly to a large object
  still costs one full upload each time it settles.
* A write is acknowledged when it is durable *locally*, not in the object store.
  A volume's WAL makes that gap recoverable; here there is no log, so a crash in
  between loses the write. `sync()` closes the window and the server calls it
  before exiting.
* Listings merge buffered files with what the store reports, or a file would
  vanish between being created and being uploaded.
* `mkdir` writes a zero-byte `prefix/` marker, the convention every S3 tool
  understands. A directory holding objects needs no marker.
* Renaming a directory is refused. It means copying every key beneath the prefix
  with no way to roll back a half-moved tree.
* No symlinks: an object store has none, and encoding them would produce files
  only this program could read.

Writes are off unless `--writable` is passed, because a browse mount points at
data this program did not create.

## Known limits

**Nothing reclaims chunks.** Overwritten and deleted chunks stay in the object
store and in the local cache forever. A mark-and-sweep GC against
`MetaStore::live_chunks` is the missing piece; content addressing makes it
safe to run concurrently with writers as long as the sweep uses a snapshot
older than any in-flight write.

**Inode locks are only loosely reclaimed.** The map of per-inode locks is swept
for unheld entries once it passes 4096, rather than being reference-counted
precisely.

**The local cache is unbounded.** No eviction, no size cap. Eviction is easy
because chunks are immutable — anything not dirty can be dropped.

**No hard links.** The `Inode` has no reference count and the namespace maps
one name to one inode. `nlink` is synthesised. Adding them means a real link
count plus unlink-vs-delete separation.

**SMB gaps.** No leases or oplocks, so no client-side caching of file data and
no `CHANGE_NOTIFY` — clients fall back to polling the directory once a second,
which works but is chatty. No named streams, no ACLs, no `IOCTL` (so no
server-side copy or sparse-file hints), no DFS. Dialect 3.1.1 is not offered
because it requires pre-auth integrity negotiate contexts; 3.0.2 is, and
carries the same AES-CMAC signing. Encryption is not advertised.

**One SMB share, one credential.** A single user and password per server
process, checked against a `Credentials` value. There is no user database and no
mapping from an authenticated SMB user to per-file ownership: files take the
volume-wide owner regardless of who wrote them.

**No NLM locking, no `access` checks.** See `docs/platforms.md`. Permission
bits are stored and reported but never enforced server-side; the client kernel
does the checking, which is the usual NFSv3 posture and not a security boundary.

**Single writer per volume.** Two servers pointed at one bucket prefix will
clobber each other's snapshots. Real multi-writer needs a lease on the pointer
object (S3 conditional writes make this feasible) — worth doing before anyone
runs two of these.

**Ownership is volume-wide.** NFSv3 AUTH_SYS credentials are not plumbed
through `nfsserve`'s VFS, so new files take the owner of the state directory
rather than the calling user.

## Things worth deciding next

1. **GC and cache eviction** — the two that turn this from a demo into
   something you can leave running.
2. **Dirty-chunk buffering** — removes the remaining sub-chunk write
   amplification, and would make small random writes usable.
3. **SMB leases/oplocks** — the single biggest performance lever now that the
   protocol works; without them clients re-read everything and poll for changes.
4. **Snapshots** — nearly free already. The snapshot object plus the chunks it
   references *is* a point-in-time image; all that is missing is not deleting
   old ones and a command to mount one read-only.
5. **A custom protocol** — only if NFSv3 semantics or its round-trip count
   actually become the bottleneck. Measure first; the layering already keeps
   this cheap to add.

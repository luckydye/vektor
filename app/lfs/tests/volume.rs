//! End-to-end tests of the engine: namespace semantics, chunked I/O, and the
//! crash/recovery contract.

use std::path::PathBuf;
use std::sync::Arc;

use lfs::error::FsError;
use lfs::fs::{FileSystem, Volume};
use lfs::storage::chunk::CHUNK_SIZE;
use lfs::storage::meta::SetAttr;

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lfs-test-{tag}-{n}"));
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        std::fs::create_dir_all(dir.join("state")).unwrap();
        Env { dir }
    }

    async fn open(&self) -> Arc<Volume> {
        Volume::open(
            self.dir.join("backend").to_str().unwrap(),
            &self.dir.join("state"),
        )
        .await
        .unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn create_write_read_roundtrip() {
    let env = Env::new("roundtrip");
    let v = env.open().await;
    let root = v.root();

    let (ino, _) = v.create(root, b"hello.txt", 0o644).await.unwrap();
    v.write(ino, 0, b"hello world").await.unwrap();

    let (data, eof) = v.read(ino, 0, 1024).await.unwrap();
    assert_eq!(data, b"hello world");
    assert!(eof);
    assert_eq!(v.getattr(ino).await.unwrap().size, 11);
}

#[tokio::test]
async fn overwrites_within_a_chunk() {
    let env = Env::new("overwrite");
    let v = env.open().await;
    let (ino, _) = v.create(v.root(), b"f", 0o644).await.unwrap();

    v.write(ino, 0, b"aaaaaaaaaa").await.unwrap();
    v.write(ino, 3, b"XYZ").await.unwrap();

    let (data, _) = v.read(ino, 0, 100).await.unwrap();
    assert_eq!(data, b"aaaXYZaaaa");
}

#[tokio::test]
async fn writes_spanning_chunks_and_holes() {
    let env = Env::new("chunks");
    let v = env.open().await;
    let (ino, _) = v.create(v.root(), b"big", 0o644).await.unwrap();

    // Straddle a chunk boundary.
    let payload = vec![7u8; 10];
    v.write(ino, CHUNK_SIZE - 5, &payload).await.unwrap();
    let (data, _) = v.read(ino, CHUNK_SIZE - 5, 10).await.unwrap();
    assert_eq!(data, payload);

    // Everything before the write is a hole and must read as zeroes.
    let (head, _) = v.read(ino, 0, 100).await.unwrap();
    assert_eq!(head, vec![0u8; 100]);
    assert_eq!(v.getattr(ino).await.unwrap().size, CHUNK_SIZE + 5);
}

#[tokio::test]
async fn truncate_shrinks_and_extends() {
    let env = Env::new("truncate");
    let v = env.open().await;
    let (ino, _) = v.create(v.root(), b"f", 0o644).await.unwrap();
    v.write(ino, 0, b"0123456789").await.unwrap();

    v.setattr(ino, SetAttr { size: Some(4), ..Default::default() }).await.unwrap();
    let (data, _) = v.read(ino, 0, 100).await.unwrap();
    assert_eq!(data, b"0123");

    v.setattr(ino, SetAttr { size: Some(8), ..Default::default() }).await.unwrap();
    let (data, _) = v.read(ino, 0, 100).await.unwrap();
    assert_eq!(data, b"0123\0\0\0\0", "extension past EOF must read as zeroes");
}

#[tokio::test]
async fn namespace_rules() {
    let env = Env::new("namespace");
    let v = env.open().await;
    let root = v.root();

    let (dir, _) = v.mkdir(root, b"d", 0o755).await.unwrap();
    let (_f, _) = v.create(dir, b"a", 0o644).await.unwrap();

    assert!(matches!(v.create(dir, b"a", 0o644).await, Err(FsError::Exists)));
    assert!(matches!(v.remove(root, b"d").await, Err(FsError::NotEmpty)));
    assert!(matches!(v.lookup(root, b"nope").await, Err(FsError::NotFound)));

    v.rename(dir, b"a", root, b"b").await.unwrap();
    assert!(v.lookup(root, b"b").await.is_ok());
    v.remove(root, b"d").await.unwrap();

    // A directory may not be moved beneath itself.
    let (outer, _) = v.mkdir(root, b"outer", 0o755).await.unwrap();
    let (inner, _) = v.mkdir(outer, b"inner", 0o755).await.unwrap();
    assert!(matches!(v.rename(root, b"outer", inner, b"x").await, Err(FsError::Inval)));
}

#[tokio::test]
async fn readdir_pages_with_cookies() {
    let env = Env::new("readdir");
    let v = env.open().await;
    let root = v.root();
    for i in 0..5 {
        v.create(root, format!("f{i}").as_bytes(), 0o644).await.unwrap();
    }

    let (first, end) = v.readdir(root, 0, 2).await.unwrap();
    assert_eq!(first.len(), 2);
    assert!(!end);

    let cookie = first.last().unwrap().1.ino;
    let (rest, end) = v.readdir(root, cookie, 10).await.unwrap();
    assert_eq!(rest.len(), 3);
    assert!(end);
}

#[tokio::test]
async fn symlinks_round_trip() {
    let env = Env::new("symlink");
    let v = env.open().await;
    let (ino, attr) = v.symlink(v.root(), b"link", b"/target/path").await.unwrap();
    assert_eq!(attr.size, 12);
    assert_eq!(v.readlink(ino).await.unwrap(), b"/target/path");
}

#[tokio::test]
async fn recovers_from_the_wal_without_a_checkpoint() {
    let env = Env::new("wal-recovery");
    {
        let v = env.open().await;
        let (ino, _) = v.create(v.root(), b"survivor", 0o644).await.unwrap();
        v.write(ino, 0, b"durable").await.unwrap();
        // No checkpoint: nothing has reached the backing store yet. This is the
        // crash case — the WAL is all we have.
    }

    let v = env.open().await;
    let ino = v.lookup(v.root(), b"survivor").await.unwrap();
    let (data, _) = v.read(ino, 0, 100).await.unwrap();
    assert_eq!(data, b"durable");
}

#[tokio::test]
async fn regular_volume_ids_survive_restart() {
    let env = Env::new("identity-recovery");
    let first = env.open().await;
    let filesystem_id = first.filesystem_id();
    let (ino, _) = first.create(first.root(), b"stable", 0o644).await.unwrap();
    first
        .rename(first.root(), b"stable", first.root(), b"renamed")
        .await
        .unwrap();
    drop(first);

    let reopened = env.open().await;
    assert_ne!(filesystem_id, 0);
    assert_eq!(reopened.filesystem_id(), filesystem_id);
    assert_eq!(reopened.getattr(ino).await.unwrap().ino, ino);
    assert_eq!(reopened.lookup(reopened.root(), b"renamed").await.unwrap(), ino);

    reopened.remove(reopened.root(), b"renamed").await.unwrap();
    let (replacement, _) = reopened.create(reopened.root(), b"renamed", 0o644).await.unwrap();
    assert_ne!(replacement, ino);
    drop(reopened);

    let reopened = env.open().await;
    assert_eq!(reopened.lookup(reopened.root(), b"renamed").await.unwrap(), replacement);
}

#[tokio::test]
async fn recovers_from_a_checkpoint_with_no_local_state() {
    let env = Env::new("checkpoint-recovery");
    {
        let v = env.open().await;
        let (ino, _) = v.create(v.root(), b"persisted", 0o644).await.unwrap();
        v.write(ino, 0, &vec![9u8; (CHUNK_SIZE + 100) as usize]).await.unwrap();
        v.checkpoint().await.unwrap();
    }

    // Throw away everything local. The object store must be self-sufficient.
    std::fs::remove_dir_all(env.dir.join("state")).unwrap();

    let v = env.open().await;
    let ino = v.lookup(v.root(), b"persisted").await.unwrap();
    let (data, _) = v.read(ino, 0, 200).await.unwrap();
    assert_eq!(data, vec![9u8; 200], "chunks must be fetched back from the backend");
    assert_eq!(v.getattr(ino).await.unwrap().size, CHUNK_SIZE + 100);
}

#[tokio::test]
async fn checkpoint_then_more_writes_then_recover() {
    let env = Env::new("mixed-recovery");
    {
        let v = env.open().await;
        let (a, _) = v.create(v.root(), b"a", 0o644).await.unwrap();
        v.write(a, 0, b"first").await.unwrap();
        v.checkpoint().await.unwrap();

        // These live only in the post-checkpoint WAL segment.
        let (b, _) = v.create(v.root(), b"b", 0o644).await.unwrap();
        v.write(b, 0, b"second").await.unwrap();
    }

    let v = env.open().await;
    let a = v.lookup(v.root(), b"a").await.unwrap();
    let b = v.lookup(v.root(), b"b").await.unwrap();
    assert_eq!(v.read(a, 0, 10).await.unwrap().0, b"first");
    assert_eq!(v.read(b, 0, 10).await.unwrap().0, b"second");
}

#[tokio::test]
async fn identical_content_deduplicates() {
    let env = Env::new("dedup");
    let v = env.open().await;
    let (a, _) = v.create(v.root(), b"a", 0o644).await.unwrap();
    let (b, _) = v.create(v.root(), b"b", 0o644).await.unwrap();

    let block = vec![3u8; CHUNK_SIZE as usize];
    v.write(a, 0, &block).await.unwrap();
    v.write(b, 0, &block).await.unwrap();

    assert_eq!(v.stats().await.dirty_chunks, 1, "same bytes must share one chunk");
}

#[tokio::test]
async fn concurrent_cold_reads_of_one_chunk() {
    // Regression: parallel cache misses on the same chunk used to race on a
    // shared temporary filename, so one of them failed with ENOENT. NFS issues
    // exactly this pattern for a large sequential read.
    let env = Env::new("cold-reads");
    let block = vec![5u8; (CHUNK_SIZE * 2) as usize];
    {
        let v = env.open().await;
        let (ino, _) = v.create(v.root(), b"f", 0o644).await.unwrap();
        v.write(ino, 0, &block).await.unwrap();
        v.checkpoint().await.unwrap();
    }
    std::fs::remove_dir_all(env.dir.join("state")).unwrap();

    let v = env.open().await;
    let ino = v.lookup(v.root(), b"f").await.unwrap();
    let mut tasks = Vec::new();
    for i in 0..16u64 {
        let v = Arc::clone(&v);
        tasks.push(tokio::spawn(async move {
            v.read(ino, i * 4096, 4096).await.unwrap().0
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap(), vec![5u8; 4096]);
    }
}

#[tokio::test]
async fn parent_links_follow_renames() {
    let env = Env::new("parent");
    let v = env.open().await;
    let root = v.root();

    let (a, _) = v.mkdir(root, b"a", 0o755).await.unwrap();
    let (b, _) = v.mkdir(root, b"b", 0o755).await.unwrap();
    let (child, _) = v.mkdir(a, b"child", 0o755).await.unwrap();

    assert_eq!(v.parent(child).await.unwrap(), a);
    assert_eq!(v.parent(root).await.unwrap(), root, "root is its own parent");

    v.rename(a, b"child", b, b"child").await.unwrap();
    assert_eq!(v.parent(child).await.unwrap(), b);
}

#[tokio::test]
async fn group_commit_still_acknowledges_only_durable_writes() {
    // Group commit lets one fsync cover many writes. The property that must
    // survive it: when a write returns, it is on disk — so a crash with no
    // checkpoint loses nothing that was acknowledged.
    let env = Env::new("group-commit");
    {
        let v = env.open().await;
        let mut tasks = Vec::new();
        for w in 0..8u64 {
            let v = Arc::clone(&v);
            tasks.push(tokio::spawn(async move {
                let (ino, _) = v
                    .create(v.root(), format!("f{w}").as_bytes(), 0o644)
                    .await
                    .unwrap();
                for block in 0..8u64 {
                    let data = vec![w as u8; 4096];
                    v.write(ino, block * 4096, &data).await.unwrap();
                }
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        // Every write above has returned, so every write above is durable.
        // No checkpoint: the WAL is the only record.
    }

    let v = env.open().await;
    for w in 0..8u64 {
        let ino = v.lookup(v.root(), format!("f{w}").as_bytes()).await.unwrap();
        let (data, _) = v.read(ino, 0, 8 * 4096).await.unwrap();
        assert_eq!(data.len(), 8 * 4096, "file {w} is short after recovery");
        assert!(
            data.iter().all(|b| *b == w as u8),
            "file {w} has wrong contents after recovery"
        );
    }
}

#[tokio::test]
async fn concurrent_writes_to_one_file_do_not_lose_each_other() {
    // Chunk rebuilds are serialised per inode; without that, two writes landing
    // in the same chunk would each rebuild it from the same stale base and one
    // would vanish.
    let env = Env::new("same-file");
    let v = env.open().await;
    let (ino, _) = v.create(v.root(), b"shared", 0o644).await.unwrap();

    // 64 writes of 1 KiB, all inside the first chunk, issued concurrently.
    let mut tasks = Vec::new();
    for i in 0..64u64 {
        let v = Arc::clone(&v);
        tasks.push(tokio::spawn(async move {
            v.write(ino, i * 1024, &vec![i as u8 + 1; 1024]).await.unwrap();
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }

    let (data, _) = v.read(ino, 0, 64 * 1024).await.unwrap();
    for i in 0..64usize {
        assert!(
            data[i * 1024..(i + 1) * 1024].iter().all(|b| *b == i as u8 + 1),
            "write {i} was lost or overwritten by a concurrent rebuild"
        );
    }
}

// ---- S3 passthrough writes ----

async fn open_browse(env: &Env, writable: bool) -> Arc<dyn FileSystem> {
    lfs::fs::passthrough::Passthrough::open(
        env.dir.join("backend").to_str().unwrap(),
        &env.dir.join("scratch"),
        writable,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn browse_writes_reach_the_object_store() {
    let env = Env::new("browse-write");
    let fs = open_browse(&env, true).await;

    let (ino, _) = fs.create(fs.root(), b"note.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"hello object store").await.unwrap();

    // Read-after-write must see the buffer, not the (absent) object.
    let (data, _) = fs.read(ino, 0, 100).await.unwrap();
    assert_eq!(data, b"hello object store");

    // Nothing is durable until the flush.
    fs.sync().await.unwrap();
    let landed = std::fs::read(env.dir.join("backend").join("note.txt")).unwrap();
    assert_eq!(landed, b"hello object store");
}

#[tokio::test]
async fn browse_ids_survive_restart() {
    let env = Env::new("browse-identities");
    std::fs::create_dir_all(env.dir.join("backend/docs")).unwrap();
    std::fs::write(env.dir.join("backend/root.txt"), b"root").unwrap();
    std::fs::write(env.dir.join("backend/docs/clip.mov"), b"clip").unwrap();

    let first = open_browse(&env, false).await;
    let filesystem_id = first.filesystem_id();
    let root_file = first.lookup(first.root(), b"root.txt").await.unwrap();
    let docs = first.lookup(first.root(), b"docs").await.unwrap();
    let clip = first.lookup(docs, b"clip.mov").await.unwrap();
    drop(first);

    let reopened = open_browse(&env, false).await;
    assert_eq!(reopened.getattr(clip).await.unwrap().size, 4);
    assert_eq!(reopened.read(clip, 0, 100).await.unwrap().0, b"clip");
    let reopened_docs = reopened.lookup(reopened.root(), b"docs").await.unwrap();
    assert_ne!(filesystem_id, 0);
    assert_eq!(reopened.filesystem_id(), filesystem_id);
    assert_eq!(reopened.lookup(reopened.root(), b"root.txt").await.unwrap(), root_file);
    assert_eq!(reopened_docs, docs);
    assert_eq!(reopened.lookup(reopened_docs, b"clip.mov").await.unwrap(), clip);
}

#[tokio::test]
async fn browse_delete_and_recreate_does_not_reuse_an_inode() {
    let env = Env::new("browse-tombstone");
    let fs = open_browse(&env, true).await;
    let (old, _) = fs.create(fs.root(), b"clip.mov", 0o644).await.unwrap();
    fs.write(old, 0, b"same").await.unwrap();
    fs.sync().await.unwrap();
    fs.remove(fs.root(), b"clip.mov").await.unwrap();

    let (new, _) = fs.create(fs.root(), b"clip.mov", 0o644).await.unwrap();
    fs.write(new, 0, b"same").await.unwrap();
    fs.sync().await.unwrap();
    assert_ne!(new, old);
    drop(fs);

    let reopened = open_browse(&env, true).await;
    assert_eq!(reopened.lookup(reopened.root(), b"clip.mov").await.unwrap(), new);
}

#[tokio::test]
async fn a_buffered_file_still_appears_in_its_directory() {
    // Listings are rebuilt from the object store, so a file that exists only in
    // the write buffer used to vanish between being created and being uploaded.
    let env = Env::new("browse-listing");
    let fs = open_browse(&env, true).await;

    let (ino, _) = fs.create(fs.root(), b"fresh.txt", 0o644).await.unwrap();
    fs.write(ino, 0, b"x").await.unwrap();

    let (entries, _) = fs.readdir(fs.root(), 0, 100).await.unwrap();
    let names: Vec<String> = entries
        .iter()
        .map(|(n, _)| String::from_utf8_lossy(n).to_string())
        .collect();
    assert!(names.contains(&"fresh.txt".to_string()), "got {names:?}");
    assert!(fs.lookup(fs.root(), b"fresh.txt").await.is_ok());
}

#[tokio::test]
async fn browse_rename_replaces_the_target() {
    // An editor saves by writing a temp file and renaming over the original.
    let env = Env::new("browse-rename");
    let fs = open_browse(&env, true).await;

    let (old, _) = fs.create(fs.root(), b"doc.txt", 0o644).await.unwrap();
    fs.write(old, 0, b"v1").await.unwrap();
    let (tmp, _) = fs.create(fs.root(), b"doc.tmp", 0o644).await.unwrap();
    fs.write(tmp, 0, b"v2").await.unwrap();

    fs.rename(fs.root(), b"doc.tmp", fs.root(), b"doc.txt").await.unwrap();
    fs.sync().await.unwrap();

    let backend = env.dir.join("backend");
    assert_eq!(std::fs::read(backend.join("doc.txt")).unwrap(), b"v2");
    assert!(!backend.join("doc.tmp").exists(), "the source must not survive");
    assert_ne!(old, tmp);
    drop(fs);

    let reopened = open_browse(&env, true).await;
    assert_eq!(reopened.lookup(reopened.root(), b"doc.txt").await.unwrap(), tmp);
}

#[tokio::test]
async fn browse_refuses_writes_when_not_writable() {
    let env = Env::new("browse-ro");
    std::fs::write(env.dir.join("backend").join("readme.txt"), b"hi").unwrap();
    let fs = open_browse(&env, false).await;

    assert!(!fs.writable());
    let ino = fs.lookup(fs.root(), b"readme.txt").await.unwrap();
    assert!(matches!(fs.write(ino, 0, b"nope").await, Err(FsError::ReadOnly)));
    assert!(matches!(fs.create(fs.root(), b"new", 0o644).await, Err(FsError::ReadOnly)));
    assert!(matches!(fs.remove(fs.root(), b"readme.txt").await, Err(FsError::ReadOnly)));

    // A read-only mount must also *look* read-only.
    let attr = fs.getattr(ino).await.unwrap();
    assert_eq!(attr.mode & 0o222, 0, "no write bits on a read-only volume");
}

#[tokio::test]
async fn a_writable_browse_mount_looks_writable() {
    // The inverse: reporting read-only modes on a writable mount makes clients
    // present it as locked and makes attribute-preserving copies fail.
    let env = Env::new("browse-modes");
    std::fs::write(env.dir.join("backend").join("f.txt"), b"hi").unwrap();
    let fs = open_browse(&env, true).await;

    let ino = fs.lookup(fs.root(), b"f.txt").await.unwrap();
    assert_ne!(fs.getattr(ino).await.unwrap().mode & 0o200, 0);
    assert_ne!(fs.getattr(fs.root()).await.unwrap().mode & 0o200, 0);
}

#[tokio::test]
async fn a_zero_length_read_returns_nothing() {
    // A byte range is inclusive of both ends, so an empty one cannot be
    // spelled. Deriving `offset + len - 1` from a zero length underflows and
    // asks the object store for everything.
    let env = Env::new("zero-read");
    std::fs::write(env.dir.join("backend").join("f.bin"), vec![1u8; 4096]).unwrap();
    let fs = open_browse(&env, false).await;

    let ino = fs.lookup(fs.root(), b"f.bin").await.unwrap();
    let (data, _) = fs.read(ino, 0, 0).await.unwrap();
    assert!(data.is_empty(), "a zero-length read returned {} bytes", data.len());

    // And a normal read still works.
    let (data, _) = fs.read(ino, 0, 100).await.unwrap();
    assert_eq!(data.len(), 100);
}

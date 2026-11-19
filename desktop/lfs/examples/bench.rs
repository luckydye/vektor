//! Engine-level throughput, with no protocol in the way.
//!
//! Run: cargo run --release --example bench

use std::sync::Arc;
use std::time::Instant;

use lfs::fs::Volume;

async fn time_writes(label: &str, volume: &Arc<Volume>, name: &[u8], io_size: usize, total: usize) {
    let (ino, _) = volume.create(volume.root(), name, 0o644).await.unwrap();
    let data = vec![7u8; io_size];

    let start = Instant::now();
    let mut offset = 0u64;
    while (offset as usize) < total {
        volume.write(ino, offset, &data).await.unwrap();
        offset += io_size as u64;
    }
    let elapsed = start.elapsed();
    let mbps = total as f64 / elapsed.as_secs_f64() / 1e6;
    println!("  {label:<28} {mbps:>8.1} MB/s   ({:>6.0} ms)", elapsed.as_millis());
}

async fn time_reads(label: &str, volume: &Arc<Volume>, name: &[u8], io_size: u32, total: usize) {
    let ino = volume.lookup(volume.root(), name).await.unwrap();
    let start = Instant::now();
    let mut offset = 0u64;
    while (offset as usize) < total {
        volume.read(ino, offset, io_size).await.unwrap();
        offset += io_size as u64;
    }
    let elapsed = start.elapsed();
    let mbps = total as f64 / elapsed.as_secs_f64() / 1e6;
    println!("  {label:<28} {mbps:>8.1} MB/s   ({:>6.0} ms)", elapsed.as_millis());
}

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join(format!("lfs-bench-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("backend")).unwrap();
    std::fs::create_dir_all(dir.join("state")).unwrap();
    let volume = Volume::open(dir.join("backend").to_str().unwrap(), &dir.join("state"))
        .await
        .unwrap();

    const TOTAL: usize = 64 * 1024 * 1024;
    println!("64 MiB through the engine, chunk size {} KiB:\n", lfs::fs::CHUNK_BYTES / 1024);

    println!("writes by request size:");
    for (label, size) in [
        ("64 KiB  (quarter chunk)", 64 * 1024),
        ("128 KiB (half chunk, NFS)", 128 * 1024),
        ("256 KiB (exactly one chunk)", 256 * 1024),
        ("1 MiB   (four chunks, SMB)", 1024 * 1024),
    ] {
        time_writes(label, &volume, format!("w{size}").as_bytes(), size, TOTAL).await;
    }

    println!("\nreads by request size (warm cache):");
    for (label, size) in [
        ("64 KiB", 64 * 1024),
        ("128 KiB", 128 * 1024),
        ("1 MiB", 1024 * 1024),
    ] {
        time_reads(label, &volume, b"w262144", size, TOTAL).await;
    }

    println!("\nconcurrent 128 KiB writers (group commit):");
    for writers in [1usize, 2, 4, 8, 16] {
        let per_writer = TOTAL / writers;
        let mut handles = Vec::new();
        let start = Instant::now();
        for w in 0..writers {
            let volume = Arc::clone(&volume);
            handles.push(tokio::spawn(async move {
                let (ino, _) = volume
                    .create(volume.root(), format!("c{writers}-{w}").as_bytes(), 0o644)
                    .await
                    .unwrap();
                let data = vec![7u8; 128 * 1024];
                let mut offset = 0u64;
                while (offset as usize) < per_writer {
                    volume.write(ino, offset, &data).await.unwrap();
                    offset += data.len() as u64;
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let elapsed = start.elapsed();
        let mbps = TOTAL as f64 / elapsed.as_secs_f64() / 1e6;
        println!("  {writers:>2} writers                   {mbps:>8.1} MB/s   ({:>6.0} ms)", elapsed.as_millis());
    }

    let _ = std::fs::remove_dir_all(&dir);
}

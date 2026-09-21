/**
 * The disk cache jobs get as `jobCache`, scoped per job id.
 *
 * It stores blobs, not JSON. A job that caches a thumbnail, a downloaded object
 * or a rendered page hands over a `Uint8Array`, and that array is what lands on
 * disk — base64 inside a JSON envelope cost a third of the file for nothing.
 * Entries are compressed unless the bytes are already a compressed format, and
 * the whole cache is held under a byte budget by evicting least-recently-read
 * entries, so a job that caches more than it should degrades instead of filling
 * the disk.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { config } from "#config";
import { appLogger } from "#observability/logger.ts";

/** Base64 envelope marking binary data across the VM boundary. */
const BYTES_KEY = "__bytes";

/** Default disk budget across every job's entries. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * How much may be written before the budget is checked again. Pruning stats
 * every entry, so it runs once per batch of writes rather than per entry.
 */
const PRUNE_AFTER_BYTES = 32 * 1024 * 1024;

/** Compression that saves less than this is not worth the CPU on every read. */
const MIN_COMPRESSION_RATIO = 0.95;

/** Below this, the header dominates and compression cannot pay for itself. */
const MIN_COMPRESSIBLE_BYTES = 1024;

/** The header is one short JSON line; this bounds what a prune has to read. */
const MAX_HEADER_BYTES = 256;

/**
 * Leading bytes of formats that are already compressed: gzip, zlib, PNG, JPEG,
 * GIF, and RIFF (WebP). Re-deflating these spends CPU to grow the file.
 */
const COMPRESSED_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x1f, 0x8b],
  [0x78, 0x01],
  [0x78, 0x9c],
  [0x78, 0xda],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
  [0x50, 0x4b, 0x03, 0x04],
];

/** One line of JSON, then the payload. Kinds: `b` bytes, `j` JSON. */
interface EntryHeader {
  expiresAt: number | null;
  kind: "b" | "j";
  gzip: boolean;
}

function isBytesEnvelope(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[BYTES_KEY] === "string"
  );
}

function looksCompressed(payload: Buffer): boolean {
  return COMPRESSED_MAGIC.some((magic) =>
    magic.every((byte, at) => payload[at] === byte),
  );
}

/** Resolved per call rather than at import, so `DATA_DIR` is read after config. */
function cacheRoot(): string {
  return join(resolve(config().DATA_DIR?.trim() || "data"), "job-cache");
}

function maxBytes(): number {
  const configured = Number(config().JOB_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

/**
 * Written bytes since the last prune, process-wide: the budget covers the whole
 * cache directory, and every run writes into the same one.
 */
let unaccountedBytes = 0;
let pruning: Promise<void> | null = null;

async function listEntries(): Promise<string[]> {
  const root = cacheRoot();
  const scopes = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(root, scope.name);
    const names = await readdir(scopeDir).catch(() => [] as string[]);
    for (const name of names) files.push(join(scopeDir, name));
  }
  return files;
}

/**
 * Drop expired entries, then the least recently read ones until the cache fits
 * its budget. Read time is the file's mtime, which {@link JobCache.get} touches
 * on a hit — atime is unreliable on the filesystems this runs on.
 */
async function prune(): Promise<void> {
  const budget = maxBytes();
  const now = Date.now();
  const entries: Array<{ path: string; size: number; usedAt: number }> = [];
  let total = 0;

  for (const path of await listEntries()) {
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    const expiresAt = await readExpiry(path);
    if (expiresAt !== null && expiresAt <= now) {
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    entries.push({ path, size: info.size, usedAt: info.mtimeMs });
    total += info.size;
  }

  if (total <= budget) return;

  entries.sort((a, b) => a.usedAt - b.usedAt);
  let evicted = 0;
  for (const entry of entries) {
    if (total <= budget) break;
    await rm(entry.path, { force: true }).catch(() => {});
    total -= entry.size;
    evicted += 1;
  }
  appLogger.info("[jobCache] evicted least-recently-used entries", {
    evicted,
    remainingBytes: total,
    budget,
  });
}

function schedulePrune(writtenBytes: number): void {
  unaccountedBytes += writtenBytes;
  if (unaccountedBytes < PRUNE_AFTER_BYTES || pruning) return;
  unaccountedBytes = 0;
  pruning = prune()
    .catch((error) => {
      appLogger.warn("[jobCache] prune failed", { error: String(error) });
    })
    .finally(() => {
      pruning = null;
    });
}

/** Reads only the header line, so pruning never pulls whole blobs into memory. */
async function readExpiry(path: string): Promise<number | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, MAX_HEADER_BYTES, 0);
    return parseHeader(head.subarray(0, bytesRead))?.header.expiresAt ?? null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseHeader(file: Buffer): { header: EntryHeader; payload: Buffer } | null {
  const split = file.indexOf(0x0a);
  if (split < 0) return null;
  try {
    return {
      header: JSON.parse(file.subarray(0, split).toString("utf8")) as EntryHeader,
      payload: file.subarray(split + 1),
    };
  } catch {
    return null;
  }
}

/** Cache scoped to one job id, persisted under `DATA_DIR/job-cache`. */
export class JobCache {
  constructor(private readonly jobId: string) {}

  private path(key: string): string {
    const scope = createHash("sha256").update(this.jobId).digest("hex").slice(0, 16);
    const name = createHash("sha256").update(String(key)).digest("hex");
    return join(cacheRoot(), scope, name);
  }

  async get(key: string): Promise<{ hit: boolean; value: unknown }> {
    const path = this.path(key);
    const file = await readFile(path).catch(() => null);
    if (!file) return { hit: false, value: null };

    const parsed = parseHeader(file);
    if (!parsed) {
      await this.delete(key);
      return { hit: false, value: null };
    }

    const { header } = parsed;
    if (header.expiresAt !== null && header.expiresAt <= Date.now()) {
      await this.delete(key);
      return { hit: false, value: null };
    }

    let payload = parsed.payload;
    try {
      if (header.gzip) payload = gunzipSync(payload);
    } catch {
      await this.delete(key);
      return { hit: false, value: null };
    }

    // The read is what makes an entry recently used; eviction reads mtime.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});

    if (header.kind === "b") {
      return { hit: true, value: { [BYTES_KEY]: payload.toString("base64") } };
    }
    try {
      return { hit: true, value: JSON.parse(payload.toString("utf8")) };
    } catch {
      await this.delete(key);
      return { hit: false, value: null };
    }
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const bytes = isBytesEnvelope(value);
    const raw = bytes
      ? Buffer.from(value[BYTES_KEY], "base64")
      : Buffer.from(JSON.stringify(value ?? null), "utf8");

    let payload = raw;
    let gzip = false;
    if (raw.byteLength >= MIN_COMPRESSIBLE_BYTES && !looksCompressed(raw)) {
      const deflated = gzipSync(raw);
      if (deflated.byteLength < raw.byteLength * MIN_COMPRESSION_RATIO) {
        payload = deflated;
        gzip = true;
      }
    }

    const header: EntryHeader = {
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
      kind: bytes ? "b" : "j",
      gzip,
    };
    const file = Buffer.concat([
      Buffer.from(`${JSON.stringify(header)}\n`, "utf8"),
      payload,
    ]);

    const path = this.path(key);
    await mkdir(join(path, ".."), { recursive: true });
    // Written beside the entry and renamed, so a crashed run cannot leave a
    // half-written file that reads as a hit.
    const staging = `${path}.${process.pid}.tmp`;
    await writeFile(staging, file);
    await rename(staging, path);

    schedulePrune(file.byteLength);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true }).catch(() => {});
  }
}

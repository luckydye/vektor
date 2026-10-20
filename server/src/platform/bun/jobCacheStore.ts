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
import { config } from "#config";
import { entryExpiry } from "#jobs/runtime/jobCache.ts";
import { appLogger } from "#observability/logger.ts";
import type { JobCacheStore } from "#platform/platform.ts";

/** Default disk budget across every job's entries. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * How much may be written before the budget is checked again. Pruning stats
 * every entry, so it runs once per batch of writes rather than per entry.
 */
const PRUNE_AFTER_BYTES = 32 * 1024 * 1024;

/** The header is one short JSON line; this bounds what a prune has to read. */
const MAX_HEADER_BYTES = 256;

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

/** Reads only the header line, so pruning never pulls whole blobs into memory. */
async function readExpiry(path: string): Promise<number | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, MAX_HEADER_BYTES, 0);
    return entryExpiry(head.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Drop expired entries, then the least recently read ones until the cache fits
 * its budget. Read time is the file's mtime, which a read touches — atime is
 * unreliable on the filesystems this runs on.
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

/** Entries under `DATA_DIR/job-cache`, one directory per scope. */
export const diskJobCacheStore: JobCacheStore = {
  async read(scope, key) {
    const path = join(cacheRoot(), scope, key);
    const file = await readFile(path).catch(() => null);
    if (!file) return null;
    // Eviction orders by mtime, so a hit has to move the entry to the front.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return file;
  },

  async write(scope, key, entry) {
    const path = join(cacheRoot(), scope, key);
    await mkdir(join(path, ".."), { recursive: true });
    // Written beside the entry and renamed, so a crashed run cannot leave a
    // half-written file that reads as a hit.
    const staging = `${path}.${process.pid}.tmp`;
    await writeFile(staging, entry);
    await rename(staging, path);

    schedulePrune(entry.byteLength);
  },

  async delete(scope, key) {
    await rm(join(cacheRoot(), scope, key), { force: true }).catch(() => {});
  },
};

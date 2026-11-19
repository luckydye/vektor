import { createHash } from "node:crypto";
import { type Unzipped, unzipSync } from "#utils/zip.ts";

/** Compressed bytes an uploaded or store-installed package archive may take. */
export const MAX_PACKAGE_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Decompressed bytes one file inside an extension package may take. */
export const MAX_PACKAGE_ENTRY_BYTES = 64 * 1024 * 1024;

/** Decompressed bytes a whole extension package may take. */
export const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;

/** How much unpacked package data is held in memory across all spaces. */
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;

interface CachedPackage {
  files: Unzipped;
  bytes: number;
}

/**
 * Unpacked packages keyed by the hash of the stored archive, most recently
 * used last. Keying on content means an updated or deleted extension simply
 * stops being asked for, so nothing has to invalidate this.
 */
const cache = new Map<string, CachedPackage>();
let cachedBytes = 0;

function evictToBudget(): void {
  for (const [key, entry] of cache) {
    if (cachedBytes <= CACHE_MAX_BYTES) return;
    cache.delete(key);
    cachedBytes -= entry.bytes;
  }
}

/**
 * Unpack an extension package, reusing an earlier unpack of the same archive.
 *
 * Listing extensions and serving their assets both read the package on every
 * request, and inflating is the expensive half — a package is inflated once per
 * version and served from memory until the budget above pushes it out.
 */
export function unzipExtensionPackage(buffer: Buffer): Unzipped {
  const key = createHash("sha256").update(buffer).digest("base64");

  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.files;
  }

  const files = unzipSync(new Uint8Array(buffer), {
    maxTotalBytes: MAX_PACKAGE_BYTES,
    maxEntryBytes: MAX_PACKAGE_ENTRY_BYTES,
  });

  let bytes = 0;
  for (const data of Object.values(files)) bytes += data.byteLength;
  cache.set(key, { files, bytes });
  cachedBytes += bytes;
  evictToBudget();

  return files;
}

export function extensionPackageCacheStats(): { packages: number; bytes: number } {
  return { packages: cache.size, bytes: cachedBytes };
}

export function clearExtensionPackageCache(): void {
  cache.clear();
  cachedBytes = 0;
}

/** How much compressed package data is held in memory across all spaces. */
const ARCHIVE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface CachedArchive {
  data: Buffer;
  bytes: number;
}

/**
 * Stored package archives keyed by space, extension and version. Serving an
 * entry should not read the zip out of the database again, and a view plus its
 * frontend entry would otherwise each fetch it.
 */
const archiveCache = new Map<string, CachedArchive>();
let cachedArchiveBytes = 0;

export function getCachedExtensionArchive(key: string): Buffer | undefined {
  const cached = archiveCache.get(key);
  if (!cached) return undefined;
  archiveCache.delete(key);
  archiveCache.set(key, cached);
  return cached.data;
}

export function cacheExtensionArchive(key: string, data: Buffer): void {
  const existing = archiveCache.get(key);
  if (existing) {
    cachedArchiveBytes -= existing.bytes;
    archiveCache.delete(key);
  }
  archiveCache.set(key, { data, bytes: data.byteLength });
  cachedArchiveBytes += data.byteLength;
  for (const [cachedKey, entry] of archiveCache) {
    if (cachedArchiveBytes <= ARCHIVE_CACHE_MAX_BYTES) return;
    archiveCache.delete(cachedKey);
    cachedArchiveBytes -= entry.bytes;
  }
}

export function clearExtensionArchiveCache(): void {
  archiveCache.clear();
  cachedArchiveBytes = 0;
}

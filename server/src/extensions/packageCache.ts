import { createHash } from "node:crypto";
import { type Unzipped, unzipSync } from "#utils/zip.ts";

/** Decompressed bytes one file inside an extension package may take. */
export const MAX_PACKAGE_ENTRY_BYTES = 16 * 1024 * 1024;

/** Decompressed bytes a whole extension package may take. */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

/** How much unpacked package data is held in memory across all spaces. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

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

import {
  unzipSync as fflateUnzipSync,
  type Unzipped,
  type Zippable,
  zipSync,
} from "fflate";

/**
 * The single module that imports `fflate` directly. Everything else goes
 * through these re-exports, so the ZIP implementation can be swapped (or
 * wrapped with shared validation) in one place.
 */
export { type Unzipped, type Zippable, zipSync };

export interface UnzipLimits {
  /** Decompressed bytes allowed across the whole archive. */
  maxTotalBytes?: number;
  /** Decompressed bytes allowed for one entry; defaults to the total. */
  maxEntryBytes?: number;
}

/**
 * Ceiling for archives nobody has vouched for. Deflate reaches ratios past
 * 1000:1, so a few hundred kilobytes of input can otherwise ask for gigabytes.
 */
export const DEFAULT_MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Unzip with a bound on how far the archive may inflate.
 *
 * The bound is checked against each entry's declared uncompressed size, which
 * is also the size fflate allocates that entry's output buffer from — the
 * buffer never grows, so a header understating the real size truncates its
 * entry instead of escaping the limit.
 */
export function unzipSync(data: Uint8Array, limits: UnzipLimits = {}): Unzipped {
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_UNZIPPED_BYTES;
  const maxEntryBytes = limits.maxEntryBytes ?? maxTotalBytes;
  let totalBytes = 0;

  return fflateUnzipSync(data, {
    filter: (file) => {
      if (file.originalSize > maxEntryBytes) {
        throw new Error(
          `Zip entry '${file.name}' decompresses to ${file.originalSize} bytes, over the ${maxEntryBytes} byte entry limit`,
        );
      }
      totalBytes += file.originalSize;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `Zip decompresses to more than the ${maxTotalBytes} byte archive limit`,
        );
      }
      return true;
    },
  });
}

/**
 * Build a deflated ZIP from in-memory entries, preserving the given order.
 * Used to package extensions (CLI `extension pack`, bundled local jobs); the
 * reader side is `#extensions/manifest.ts`.
 */
export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.name] = new Uint8Array(entry.data);
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

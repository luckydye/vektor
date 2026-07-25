import { unzipSync, type Zippable, zipSync } from "fflate";

/**
 * The single module that imports `fflate` directly. Everything else goes
 * through these re-exports, so the ZIP implementation can be swapped (or
 * wrapped with shared validation) in one place.
 */
export { unzipSync, type Zippable, zipSync };

export interface ZipEntry {
  name: string;
  data: Buffer;
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

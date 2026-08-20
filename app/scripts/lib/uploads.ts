/**
 * Content-addressed upload store, writing exactly what `vektor upload` writes:
 * `sha256(bytes)` as the identity and `<hash[0:2]>/<hash>.<ext>` as the key.
 *
 * Wiki exports repeat the same logo on fifty pages, so identical payloads
 * collapsing to one key and one `file` row is the point rather than a bonus.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UploadRow {
  key: string;
  url: string;
  name: string;
  mimeType: string | null;
}

export class UploadStore {
  private readonly rowsByKey = new Map<string, UploadRow>();
  /** Attachments refused for size, reported so a missing image is never silent. */
  readonly skipped: string[] = [];

  constructor(
    private readonly root: string,
    private readonly spaceId: string,
    private readonly maxBytes: number,
  ) {}

  /** Writes the payload and returns its upload URL, or null if it is too large. */
  add(bytes: Uint8Array, filename: string): string | null {
    if (bytes.byteLength > this.maxBytes) {
      this.skipped.push(`${filename} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
      return null;
    }

    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = filename.split(".").pop()?.toLowerCase() ?? "bin";
    const key = `${hash.slice(0, 2)}/${hash}.${/^[a-z0-9]{1,12}$/.test(extension) ? extension : "bin"}`;
    const url = `/api/v1/spaces/${this.spaceId}/uploads/${key}`;

    const existing = this.rowsByKey.get(key);
    if (existing) return existing.url;

    const target = join(this.root, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    this.rowsByKey.set(key, {
      key,
      url,
      name: filename,
      // Exports rarely record a mimetype; Bun derives one from the extension,
      // as the upload route does from the browser's.
      mimeType: Bun.file(filename).type || null,
    });
    return url;
  }

  get size(): number {
    return this.rowsByKey.size;
  }

  rows(): UploadRow[] {
    return [...this.rowsByKey.values()];
  }
}

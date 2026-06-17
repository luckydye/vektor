import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredFileInfo {
  key: string;
  size: number;
  updatedAt: Date;
}

/**
 * Pluggable file storage adapter.
 * Default: LocalFileStorageAdapter (data/uploads/).
 * Implement this interface to add S3, GCS, Azure Blob, etc.
 */
export interface FileStorageAdapter {
  /** Store a file buffer at the given key. Returns the public serving URL. */
  put(
    spaceId: string,
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<string>;
  /** Read a file by key. Returns null if not found. */
  read(spaceId: string, key: string): Promise<Buffer | null>;
  /** Delete a file by key. */
  delete(spaceId: string, key: string): Promise<void>;
  /** List all content-addressable (hash-prefix) files for a space. */
  list(spaceId: string): Promise<StoredFileInfo[]>;
  /** Compute the serving URL for a key (no I/O). */
  url(spaceId: string, key: string): string;
  /**
   * For object storage: return a direct URL to redirect to instead of proxying.
   * Return null or omit to serve through the API route.
   */
  redirectUrl?(spaceId: string, key: string): Promise<string | null>;
}

class LocalFileStorageAdapter implements FileStorageAdapter {
  constructor(private readonly root: string) {}

  private resolvePath(spaceId: string, key: string): string {
    return join(this.root, spaceId, key);
  }

  url(spaceId: string, key: string): string {
    return `/api/v1/spaces/${spaceId}/uploads/${key}`;
  }

  async put(
    spaceId: string,
    key: string,
    buffer: Buffer,
    _contentType?: string,
  ): Promise<string> {
    const filePath = this.resolvePath(spaceId, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return this.url(spaceId, key);
  }

  async read(spaceId: string, key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(spaceId, key));
    } catch {
      return null;
    }
  }

  async delete(spaceId: string, key: string): Promise<void> {
    await unlink(this.resolvePath(spaceId, key)).catch(() => {});
  }

  async list(spaceId: string): Promise<StoredFileInfo[]> {
    const spaceRoot = join(this.root, spaceId);
    const results: StoredFileInfo[] = [];
    try {
      const entries = await readdir(spaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        // Only scan 2-char hex prefix directories (content-addressable format)
        if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
        const subDir = join(spaceRoot, entry.name);
        const subEntries = await readdir(subDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isFile()) continue;
          const fileStat = await stat(join(subDir, sub.name)).catch(() => null);
          if (!fileStat) continue;
          results.push({
            key: `${entry.name}/${sub.name}`,
            size: fileStat.size,
            updatedAt: fileStat.mtime,
          });
        }
      }
    } catch {
      // Space dir doesn't exist yet
    }
    return results;
  }
}

let _adapter: FileStorageAdapter | null = null;

export function getFileStorage(): FileStorageAdapter {
  if (!_adapter) {
    _adapter = new LocalFileStorageAdapter(join(process.cwd(), "data", "uploads"));
  }
  return _adapter;
}

/** Override the storage adapter (useful for testing or alternate backends). */
export function setFileStorage(adapter: FileStorageAdapter): void {
  _adapter = adapter;
}

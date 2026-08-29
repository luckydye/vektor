import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { config } from "#config";
import { createS3FileStorage } from "./s3Storage.ts";

export interface StoredFileInfo {
  key: string;
  size: number;
  updatedAt: Date;
}

export interface ListOptions {
  /**
   * Key prefix to list under. Omitted, only the content-addressable uploads
   * layout (`<2 hex>/<name>`) is listed — everything else a space stores under
   * its own prefixes stays out of an upload listing.
   */
  prefix?: string;
  /** Continue a previous page: the `cursor` it returned, opaque to callers. */
  cursor?: string;
  /** Ceiling on entries per page. A backend may return fewer and still have more. */
  limit?: number;
}

export interface StoredFileListing {
  files: StoredFileInfo[];
  /** Set while more entries remain; pass it back as `cursor`. */
  cursor?: string;
}

/** What a stored object is, without its bytes. */
export interface StoredFileStat {
  size: number;
  updatedAt: Date;
  /**
   * The object's HTTP entity tag, quotes included, for conditional requests.
   *
   * An object store returns one of its own; a filesystem has none, so the local
   * adapter derives it from size and mtime. Either way it only has to change
   * when the bytes do, which is all a caller comparing two of them needs.
   */
  etag: string;
}

/**
 * A byte range, inclusive of both ends — the interval HTTP `Range` names and
 * the one S3 takes verbatim in its own `Range` header.
 */
export interface ByteRange {
  start: number;
  end: number;
}

/** A file that has landed in storage under its content-addressed key. */
export interface StoredUpload {
  key: string;
  url: string;
  size: number;
}

/**
 * A space id that can safely be a path or key segment. Ids are generated, but
 * they also arrive from URLs, so the one that reaches an adapter is checked
 * rather than trusted.
 */
export function isSafeSpaceId(spaceId: string): boolean {
  return (
    spaceId.length > 0 && !spaceId.includes("/") && spaceId !== "." && spaceId !== ".."
  );
}

/**
 * The storage-relative key for `key` within `spaceId`, or null when it would
 * escape the space.
 *
 * Shared by both adapters: a key reaches them from a URL, from the `file` table
 * and from a listing, and an object key traverses on `..` exactly as a path
 * does — S3 stores `space_1/../space_2/x` under whatever the client resolved.
 */
export function containedKey(spaceId: string, key: string): string | null {
  if (!isSafeSpaceId(spaceId)) return null;
  const root = `/${spaceId}`;
  const target = posix.resolve(root, key);
  return target.startsWith(`${root}/`) ? target.slice(1) : null;
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
  /**
   * Store a stream under the SHA-256 of its own bytes, never holding the whole
   * file in memory. The key follows from the content, so it is only known once
   * the last chunk has been read: an implementation stages the bytes somewhere
   * of its own choosing and moves them into place afterwards.
   */
  putHashed(
    spaceId: string,
    extension: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
  ): Promise<StoredUpload>;
  /**
   * Read a whole file by key. Null if not found.
   *
   * Every byte lands in memory, so this is for callers that genuinely need all
   * of them — a transform input, text extraction — and never for serving.
   * Serving a 1 GB upload through here would hold 1 GB per concurrent request;
   * {@link readStream} is the path for that.
   */
  read(spaceId: string, key: string): Promise<Buffer | null>;
  /**
   * Size and mtime without fetching the bytes. Null if not found.
   *
   * Serving a range needs the total length before it can answer, and asking for
   * it must not cost a download — locally a `stat`, against an object store a
   * HEAD.
   */
  stat(spaceId: string, key: string): Promise<StoredFileStat | null>;
  /**
   * The stored bytes as a stream, or just `range` of them. Null if not found.
   *
   * The unit every backend already speaks: a file descriptor with an offset, an
   * S3 `Range` header, an HTTP byte-range to a CDN. A caller streams the result
   * straight into a `Response` and never holds the object.
   */
  readStream(
    spaceId: string,
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null>;
  /** Delete a file by key. */
  delete(spaceId: string, key: string): Promise<void>;
  /**
   * One page of the space's stored objects.
   *
   * Paged rather than whole: a space's uploads are unbounded, and against an
   * object store a full listing is a loop of requests whose result a caller
   * would otherwise have to hold entirely in memory.
   */
  list(spaceId: string, options?: ListOptions): Promise<StoredFileListing>;
  /** Compute the serving URL for a key (no I/O). */
  url(spaceId: string, key: string): string;
  /**
   * For object storage: return a direct URL to redirect to instead of proxying.
   * Return null or omit to serve through the API route.
   */
  redirectUrl?(spaceId: string, key: string): Promise<string | null>;
}

/**
 * A filesystem stand-in for an object store's entity tag. Size and mtime are
 * what change when the bytes do, and both come from the `stat` a caller already
 * needed.
 */
function fileEtag(info: Stats): string {
  return `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
}

class LocalFileStorageAdapter implements FileStorageAdapter {
  constructor(private readonly root: string) {}

  /** Where a key lives, or null when it would land outside the space. */
  private resolvePath(spaceId: string, key: string): string | null {
    const contained = containedKey(spaceId, key);
    return contained ? join(this.root, contained) : null;
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
    // A write is the one caller that must not fail quietly: silently storing
    // nothing would report a URL that serves 404 forever.
    if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return this.url(spaceId, key);
  }

  async putHashed(
    spaceId: string,
    extension: string,
    body: ReadableStream<Uint8Array>,
    _contentType?: string,
  ): Promise<StoredUpload> {
    const stagingPath = join(this.root, spaceId, ".staging", randomUUID());
    await mkdir(dirname(stagingPath), { recursive: true });

    const hash = createHash("sha256");
    let size = 0;
    try {
      const handle = await open(stagingPath, "w");
      try {
        for await (const chunk of body) {
          hash.update(chunk);
          size += chunk.byteLength;
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }

      const digest = hash.digest("hex");
      const key = `${digest.slice(0, 2)}/${digest}.${extension}`;
      const filePath = this.resolvePath(spaceId, key);
      // The digest cannot escape the space, so only a hostile `extension` could
      // — and a write that would land outside must fail rather than report a
      // URL for bytes nobody can serve.
      if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
      await mkdir(dirname(filePath), { recursive: true });
      await rename(stagingPath, filePath);
      return { key, url: this.url(spaceId, key), size };
    } catch (error) {
      await unlink(stagingPath).catch(() => {});
      throw error;
    }
  }

  async read(spaceId: string, key: string): Promise<Buffer | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  async stat(spaceId: string, key: string): Promise<StoredFileStat | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    try {
      const info = await stat(filePath);
      // A directory is not a stored object, and answering with its size would
      // send a caller on to request bytes that do not exist.
      if (!info.isFile()) return null;
      return { size: info.size, updatedAt: info.mtime, etag: fileEtag(info) };
    } catch {
      return null;
    }
  }

  async readStream(
    spaceId: string,
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    // `createReadStream` does not reject a missing file — it emits on the
    // stream, which by then is already the response body. Ask first.
    if (!(await this.stat(spaceId, key))) return null;
    const stream = range
      ? createReadStream(filePath, { start: range.start, end: range.end })
      : createReadStream(filePath);
    return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(spaceId: string, key: string): Promise<void> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return;
    await unlink(filePath).catch(() => {});
  }

  async list(spaceId: string, options: ListOptions = {}): Promise<StoredFileListing> {
    const spaceRoot = containedKey(spaceId, options.prefix ?? ".");
    if (spaceRoot === null && options.prefix !== undefined) {
      return { files: [] };
    }
    const root = join(this.root, spaceId);
    const keys = await this.collectKeys(root, options.prefix);
    // Sorted so a cursor can be a key: the page after `cursor` is well defined
    // only if the order is, and lexical order is the one S3 also lists in.
    keys.sort();

    const after = options.cursor;
    const page = after ? keys.filter((key) => key > after) : keys;
    const limited = options.limit ? page.slice(0, options.limit) : page;

    const files: StoredFileInfo[] = [];
    for (const key of limited) {
      const info = await stat(join(root, key)).catch(() => null);
      if (!info) continue;
      files.push({ key, size: info.size, updatedAt: info.mtime });
    }

    const more = limited.length < page.length;
    return more ? { files, cursor: limited.at(-1) } : { files };
  }

  /**
   * Keys under `prefix`, or every content-addressable key when it is omitted.
   *
   * The `.staging` directory is skipped: an upload in flight is not a stored
   * object, and it disappears again either way.
   */
  private async collectKeys(root: string, prefix?: string): Promise<string[]> {
    const walk = async (dir: string, base: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const found: string[] = [];
      for (const entry of entries) {
        if (entry.name === ".staging") continue;
        const key = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          found.push(...(await walk(join(dir, entry.name), key)));
        } else if (entry.isFile()) {
          found.push(key);
        }
      }
      return found;
    };

    if (prefix === undefined) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
        found.push(...(await walk(join(root, entry.name), entry.name)));
      }
      return found;
    }

    // A prefix is a key prefix, not necessarily a directory: list its parent
    // and keep what starts with it, the way an object store would.
    const slash = prefix.lastIndexOf("/");
    const parent = slash === -1 ? "" : prefix.slice(0, slash);
    const keys = await walk(join(root, parent), parent);
    return keys.filter((key) => key.startsWith(prefix));
  }
}

/**
 * A local adapter rooted at `root`, which holds one directory per space.
 *
 * Exported so a root can be chosen rather than inherited from the process's
 * working directory — a test wants its own, and a configured deployment will
 * want one that is not relative to wherever the binary was started.
 */
export function createLocalFileStorage(root: string): FileStorageAdapter {
  return new LocalFileStorageAdapter(root);
}

/**
 * Every page of a listing, for the callers that genuinely need the whole set —
 * rebuilding an index, reconciling against the database. Anything serving a
 * request should page instead.
 */
export async function listAllFiles(
  storage: FileStorageAdapter,
  spaceId: string,
  options: Omit<ListOptions, "cursor"> = {},
): Promise<StoredFileInfo[]> {
  const files: StoredFileInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(spaceId, { ...options, cursor });
    files.push(...page.files);
    cursor = page.cursor;
  } while (cursor);
  return files;
}

let _adapter: FileStorageAdapter | null = null;

/**
 * The configured adapter: S3-compatible object storage when a bucket is set,
 * and `data/uploads` otherwise. Resolved on first use rather than at import so
 * the environment is read after config.
 */
export function getFileStorage(): FileStorageAdapter {
  if (_adapter) return _adapter;

  const env = config();
  const bucket = env.S3_BUCKET?.trim();
  if (bucket) {
    _adapter = createS3FileStorage({
      bucket,
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      region: env.S3_REGION?.trim() || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || undefined,
      sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined,
      virtualHostedStyle:
        env.S3_VIRTUAL_HOSTED_STYLE === "1" || env.S3_VIRTUAL_HOSTED_STYLE === "true",
      prefix: env.S3_PREFIX?.trim() || undefined,
      stagingDir: join(process.cwd(), "data", "s3-staging"),
    });
    return _adapter;
  }

  _adapter = new LocalFileStorageAdapter(join(process.cwd(), "data", "uploads"));
  return _adapter;
}

/**
 * Override the storage adapter. `null` restores the default, which matters
 * because the server test project runs `isolate: false` — a spec that swaps the
 * adapter and does not put it back swaps it for every spec after it.
 */
export function setFileStorage(adapter: FileStorageAdapter | null): void {
  _adapter = adapter;
}

import { posix } from "node:path";

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

/**
 * What a conditional write requires of the key's current state. A write with
 * neither condition is an ordinary {@link BlobStore.put}, so the two
 * are exclusive rather than optional.
 */
export type PutCondition =
  /** Apply only while the stored object still carries this entity tag. */
  | { ifMatch: string }
  /** Apply only while nothing is stored under the key. */
  | { ifNoneMatch: true };

/**
 * A conflict is an outcome, not a failure: losing a race is the expected way
 * for a concurrent writer to find out it has to re-read and try again.
 */
export type ConditionalPutResult = { ok: true; etag: string } | { ok: false };

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
 * Keyed byte storage scoped per space: a local directory, an S3-compatible
 * bucket, or whatever else a deployment target provides.
 */
export interface BlobStore {
  /** Store a file buffer at the given key. Returns the public serving URL. */
  put(
    spaceId: string,
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<string>;
  /**
   * Store a buffer only while `condition` holds, reporting a conflict rather
   * than throwing when it does not.
   *
   * The primitive behind optimistic concurrency on a stored object: read it
   * with its entity tag, decide, then write back naming the tag you decided
   * from. Without it two writers to one key silently resolve last-writer-wins.
   */
  putConditional(
    spaceId: string,
    key: string,
    buffer: Buffer,
    condition: PutCondition,
    contentType?: string,
  ): Promise<ConditionalPutResult>;
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
   * Store a stream at a known key without holding it in memory. Nothing lands
   * under the key unless the stream ends cleanly, so erroring it aborts the write.
   */
  putStream(
    spaceId: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
  ): Promise<void>;
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
   * Delete everything stored for the space, whatever prefix it lives under.
   *
   * Its own method rather than a listing the caller deletes from: locally the
   * whole tree goes in one call, and against an object store the keys have to
   * be enumerated and batched — neither of which a caller reclaiming a deleted
   * space should have to know.
   *
   * Throws if anything is left behind. A caller reports this as the space's
   * data reclaimed, so unlike {@link delete} it must not fail quietly.
   */
  deleteAll(spaceId: string): Promise<void>;
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
 * Every page of a listing, for the callers that genuinely need the whole set —
 * rebuilding an index, reconciling against the database. Anything serving a
 * request should page instead.
 */
export async function listAllFiles(
  storage: BlobStore,
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

/** Delete every object under `prefix`; returns how many there were. */
export async function deletePrefix(
  storage: BlobStore,
  spaceId: string,
  prefix: string,
): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await storage.list(spaceId, { prefix, cursor });
    for (const file of page.files) await storage.delete(spaceId, file.key);
    removed += page.files.length;
    cursor = page.cursor;
  } while (cursor);
  return removed;
}

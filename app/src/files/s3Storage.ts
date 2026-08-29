import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ByteRange,
  type ConditionalPutResult,
  containedKey,
  type FileStorageAdapter,
  isSafeSpaceId,
  type ListOptions,
  type PutCondition,
  type StoredFileInfo,
  type StoredFileListing,
  type StoredFileStat,
  type StoredUpload,
} from "./storage.ts";

export interface S3StorageOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Path-style addressing by default, which is what MinIO and RustFS speak. */
  virtualHostedStyle?: boolean;
  /** Prefixed before every key, for a bucket shared with something else. */
  prefix?: string;
  /** Where {@link S3FileStorageAdapter.putHashed} stages bytes; see its note. */
  stagingDir: string;
}

/** Objects listed by `list`, matching the local adapter's hash-prefix layout. */
const CONTENT_ADDRESSED_KEY = /^[0-9a-f]{2}\/[^/]+$/;

class S3FileStorageAdapter implements FileStorageAdapter {
  private readonly client: Bun.S3Client;
  private readonly prefix: string;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new Bun.S3Client({
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      virtualHostedStyle: options.virtualHostedStyle ?? false,
    });
    this.prefix = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/` : "";
  }

  /**
   * The object key for `key` in `spaceId`, or null when it would escape the
   * space. Object keys are strings rather than paths, but `..` still traverses
   * them: S3 stores `space_1/../space_2/x` under whatever the client resolved.
   */
  private objectKey(spaceId: string, key: string): string | null {
    const contained = containedKey(spaceId, key);
    return contained ? `${this.prefix}${contained}` : null;
  }

  url(spaceId: string, key: string): string {
    return `/api/v1/spaces/${spaceId}/uploads/${key}`;
  }

  async put(
    spaceId: string,
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<string> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) throw new Error(`Refusing to write outside the space: ${key}`);
    await this.client.file(objectKey).write(buffer, { type: contentType });
    return this.url(spaceId, key);
  }

  /**
   * Bun's S3 client has no conditional-write option, so the request is
   * presigned and the condition attached as a header. The signature covers the
   * query string rather than these headers, and the server still enforces them
   * — verified against AWS's own semantics and a RustFS instance.
   */
  async putConditional(
    spaceId: string,
    key: string,
    buffer: Buffer,
    condition: PutCondition,
    contentType?: string,
  ): Promise<ConditionalPutResult> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) throw new Error(`Refusing to write outside the space: ${key}`);

    const headers: Record<string, string> =
      "ifMatch" in condition
        ? { "If-Match": condition.ifMatch }
        : { "If-None-Match": "*" };
    if (contentType) headers["Content-Type"] = contentType;

    const url = this.client.presign(objectKey, {
      method: "PUT",
      expiresIn: 60,
      type: contentType,
    });
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(buffer),
    });

    // 412 is the condition failing. 404 is `If-Match` against a key that is no
    // longer there, which is the same answer: what the caller read is gone.
    if (response.status === 412 || response.status === 404) return { ok: false };
    if (!response.ok) {
      throw new Error(
        `Conditional write failed with ${response.status}: ${await response.text()}`,
      );
    }

    const etag = response.headers.get("etag");
    if (etag) return { ok: true, etag };
    // Some implementations omit it on the response; ask rather than guess.
    const written = await this.stat(spaceId, key);
    return written ? { ok: true, etag: written.etag } : { ok: false };
  }

  /**
   * The key follows from the SHA-256 of the bytes, so it is only known once the
   * last chunk has been read — and S3 has no rename to move an object into
   * place afterwards. The bytes are staged on local disk instead, which is also
   * the only staging area both a single-part and a multipart upload can be
   * retried from.
   */
  async putHashed(
    spaceId: string,
    extension: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
  ): Promise<StoredUpload> {
    const stagingPath = join(this.options.stagingDir, randomUUID());
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
      const objectKey = this.objectKey(spaceId, key);
      // Only a hostile `extension` could escape, and a write that would land
      // outside must fail rather than report a URL for bytes nobody can serve.
      if (!objectKey) throw new Error(`Refusing to write outside the space: ${key}`);
      await this.client.file(objectKey).write(Bun.file(stagingPath), {
        type: contentType,
      });
      return { key, url: this.url(spaceId, key), size };
    } finally {
      await rm(stagingPath, { force: true }).catch(() => {});
    }
  }

  async read(spaceId: string, key: string): Promise<Buffer | null> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) return null;
    try {
      return Buffer.from(await this.client.file(objectKey).arrayBuffer());
    } catch {
      return null;
    }
  }

  async stat(spaceId: string, key: string): Promise<StoredFileStat | null> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) return null;
    try {
      const info = await this.client.file(objectKey).stat();
      return { size: info.size, updatedAt: info.lastModified, etag: info.etag };
    } catch {
      return null;
    }
  }

  async readStream(
    spaceId: string,
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) return null;
    // A miss has to be answerable before a stream is handed out: by the time a
    // GET fails, the body is already the response. That costs a HEAD, which the
    // serving route needs for the total length anyway.
    if (!(await this.stat(spaceId, key))) return null;
    const file = this.client.file(objectKey);
    // `ByteRange` is inclusive of both ends, as HTTP means it; `slice` is not.
    return (range ? file.slice(range.start, range.end + 1) : file).stream();
  }

  async delete(spaceId: string, key: string): Promise<void> {
    const objectKey = this.objectKey(spaceId, key);
    if (!objectKey) return;
    await this.client
      .file(objectKey)
      .delete()
      .catch(() => {});
  }

  async list(spaceId: string, options: ListOptions = {}): Promise<StoredFileListing> {
    if (!isSafeSpaceId(spaceId)) return { files: [] };
    const base = `${this.prefix}${spaceId}/`;
    const prefix = options.prefix === undefined ? base : `${base}${options.prefix}`;

    const page = await this.client.list({
      prefix,
      continuationToken: options.cursor,
      maxKeys: options.limit,
    });

    const files: StoredFileInfo[] = [];
    for (const object of page.contents ?? []) {
      const key = object.key.slice(base.length);
      // Without an explicit prefix the listing is the uploads layout alone, so
      // anything a space stores under its own prefixes is filtered back out.
      if (options.prefix === undefined && !CONTENT_ADDRESSED_KEY.test(key)) continue;
      files.push({
        key,
        size: object.size ?? 0,
        updatedAt: object.lastModified ? new Date(object.lastModified) : new Date(0),
      });
    }

    // `maxKeys` counts objects before that filter, so a page can come back
    // short while more remain — the cursor, not the count, says whether it did.
    return page.isTruncated && page.nextContinuationToken
      ? { files, cursor: page.nextContinuationToken }
      : { files };
  }
}

/**
 * Deliberately no `redirectUrl`: every upload is served through the API route.
 *
 * A 302 to a presigned URL would drop `servedFileSecurityHeaders` — the
 * `attachment` disposition that stops an uploaded SVG or HTML file executing as
 * a document, plus the sandbox CSP and `nosniff` — and Bun's `presign` cannot
 * set the response-header overrides that would put them back.
 */
export function createS3FileStorage(options: S3StorageOptions): FileStorageAdapter {
  return new S3FileStorageAdapter(options);
}

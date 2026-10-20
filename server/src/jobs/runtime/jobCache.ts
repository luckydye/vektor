/**
 * The disk cache jobs get as `jobCache`, scoped per job id.
 *
 * It stores blobs, not JSON. A job that caches a thumbnail, a downloaded object
 * or a rendered page hands over a `Uint8Array`, and that array is what lands on
 * disk — base64 inside a JSON envelope cost a third of the file for nothing.
 * Entries are compressed unless the bytes are already a compressed format, and
 * the platform's store holds the whole cache under a byte budget by evicting
 * least-recently-read entries, so a job that caches more than it should
 * degrades instead of filling the disk.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JobCacheStore } from "#platform/platform.ts";

/** Base64 envelope marking binary data across the VM boundary. */
const BYTES_KEY = "__bytes";

/** Compression that saves less than this is not worth the CPU on every read. */
const MIN_COMPRESSION_RATIO = 0.95;

/** Below this, the header dominates and compression cannot pay for itself. */
const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Leading bytes of formats that are already compressed: gzip, zlib, PNG, JPEG,
 * GIF, and RIFF (WebP). Re-deflating these spends CPU to grow the file.
 */
const COMPRESSED_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x1f, 0x8b],
  [0x78, 0x01],
  [0x78, 0x9c],
  [0x78, 0xda],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
  [0x50, 0x4b, 0x03, 0x04],
];

/** One line of JSON, then the payload. Kinds: `b` bytes, `j` JSON. */
interface EntryHeader {
  expiresAt: number | null;
  kind: "b" | "j";
  gzip: boolean;
}

function isBytesEnvelope(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[BYTES_KEY] === "string"
  );
}

function looksCompressed(payload: Buffer): boolean {
  return COMPRESSED_MAGIC.some((magic) =>
    magic.every((byte, at) => payload[at] === byte),
  );
}

/** When the entry whose file starts with `head` expires, or null for never. */
export function entryExpiry(head: Buffer): number | null {
  return parseHeader(head)?.header.expiresAt ?? null;
}

function parseHeader(file: Buffer): { header: EntryHeader; payload: Buffer } | null {
  const split = file.indexOf(0x0a);
  if (split < 0) return null;
  try {
    return {
      header: JSON.parse(file.subarray(0, split).toString("utf8")) as EntryHeader,
      payload: file.subarray(split + 1),
    };
  } catch {
    return null;
  }
}

/** Cache scoped to one job id, persisted in a platform's job cache store. */
export class JobCache {
  readonly scope: string;

  constructor(
    readonly store: JobCacheStore,
    jobId: string,
  ) {
    this.scope = createHash("sha256").update(jobId).digest("hex").slice(0, 16);
  }

  name(key: string): string {
    return createHash("sha256").update(String(key)).digest("hex");
  }

  /**
   * The stored payload, decompressed, or null when the entry is missing or
   * expired. Reading is what marks an entry recently used.
   */
  async read(
    key: string,
  ): Promise<{ payload: Buffer; kind: EntryHeader["kind"] } | null> {
    const file = await this.store.read(this.scope, this.name(key));
    if (!file) return null;

    const parsed = parseHeader(file);
    if (!parsed) {
      await this.delete(key);
      return null;
    }

    const { header } = parsed;
    if (header.expiresAt !== null && header.expiresAt <= Date.now()) {
      await this.delete(key);
      return null;
    }

    let payload = parsed.payload;
    try {
      if (header.gzip) payload = gunzipSync(payload);
    } catch {
      await this.delete(key);
      return null;
    }

    return { payload, kind: header.kind };
  }

  async write(
    key: string,
    raw: Buffer,
    kind: EntryHeader["kind"],
    ttlMs?: number,
  ): Promise<void> {
    let payload = raw;
    let gzip = false;
    if (raw.byteLength >= MIN_COMPRESSIBLE_BYTES && !looksCompressed(raw)) {
      const deflated = gzipSync(raw);
      if (deflated.byteLength < raw.byteLength * MIN_COMPRESSION_RATIO) {
        payload = deflated;
        gzip = true;
      }
    }

    const header: EntryHeader = {
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
      kind,
      gzip,
    };
    const file = Buffer.concat([
      Buffer.from(`${JSON.stringify(header)}\n`, "utf8"),
      payload,
    ]);

    await this.store.write(this.scope, this.name(key), file);
  }

  /** Bytes as the host holds them; the guest path goes through {@link get}. */
  async readBytes(key: string): Promise<Buffer | null> {
    const entry = await this.read(key);
    return entry && entry.kind === "b" ? entry.payload : null;
  }

  writeBytes(key: string, bytes: Buffer, ttlMs?: number): Promise<void> {
    return this.write(key, bytes, "b", ttlMs);
  }

  async readJson<T>(key: string): Promise<T | null> {
    const entry = await this.read(key);
    if (entry?.kind !== "j") return null;
    try {
      return JSON.parse(entry.payload.toString("utf8")) as T;
    } catch {
      await this.delete(key);
      return null;
    }
  }

  writeJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    return this.write(
      key,
      Buffer.from(JSON.stringify(value ?? null), "utf8"),
      "j",
      ttlMs,
    );
  }

  /** The guest-facing read: a bytes entry comes back as its envelope. */
  async get(key: string): Promise<{ hit: boolean; value: unknown }> {
    const entry = await this.read(key);
    if (!entry) return { hit: false, value: null };
    if (entry.kind === "b") {
      return { hit: true, value: { [BYTES_KEY]: entry.payload.toString("base64") } };
    }
    try {
      return { hit: true, value: JSON.parse(entry.payload.toString("utf8")) };
    } catch {
      await this.delete(key);
      return { hit: false, value: null };
    }
  }

  set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    return isBytesEnvelope(value)
      ? this.writeBytes(key, Buffer.from(value[BYTES_KEY], "base64"), ttlMs)
      : this.writeJson(key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(this.scope, this.name(key));
  }
}

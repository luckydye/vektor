/**
 * Binary job outputs, handed to the caller as a URL instead of as base64.
 *
 * A job that produces bytes — a thumbnail, a rendered page, a converted file —
 * used to have two ways out: base64 inside a text output, or `uploadArtifact`,
 * which makes the bytes a permanent, searchable space upload. Neither fits
 * something derived and disposable, so `{ type: "blob", bytes }` is stored here
 * and replaced with `{ type: "blob", url }`. The caller fetches it as an
 * ordinary image or file, with no encoding tax and the browser's cache in play.
 *
 * Storage is the job cache: the same compression, the same disk budget and the
 * same least-recently-read eviction. A blob is therefore a handout with a
 * lifetime, not a file — a job that needs its bytes to survive keeps them in its
 * own cache and re-publishes on demand.
 */

import { randomBytes } from "node:crypto";
import { MIME_TYPES } from "#files/fileTypes.ts";
import { JobCache } from "./runtime/jobCache.ts";

/** One cache scope for every run's blobs; ids are unguessable, not sequential. */
const store = new JobCache("__job-output-blobs");

/** How long a published blob stays fetchable, absent an earlier eviction. */
const BLOB_TTL_MS = 24 * 60 * 60 * 1000;

/** Ceiling for one blob, so an output cannot flush the whole cache. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * The extension a served blob is treated as, which is how the upload path
 * decides inline versus download. A type with no entry here is served as an
 * unnamed download: the response is same-origin with the API, so a job-chosen
 * `text/html` — or an SVG, which scripts — must never render there.
 */
const EXTENSION_BY_MIME_TYPE = new Map(
  Object.entries(MIME_TYPES).map(([extension, mimeType]) => [mimeType, extension]),
);

export interface BlobMeta {
  spaceId: string;
  mimeType: string;
  name: string | null;
  size: number;
}

export interface StoredBlob extends BlobMeta {
  bytes: Buffer;
  /** Drives `Content-Disposition`; undefined for a type nothing maps. */
  extension: string | undefined;
}

function metaKey(id: string): string {
  return `${id}.meta`;
}

export function blobUrl(spaceId: string, id: string): string {
  return `/api/v1/spaces/${encodeURIComponent(spaceId)}/jobs/blobs/${id}`;
}

export async function putBlob(
  spaceId: string,
  bytes: Buffer,
  mimeType: string,
  name: string | null,
): Promise<{ id: string; size: number }> {
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    throw new Error(
      `blob output is ${bytes.byteLength} bytes, over the ${MAX_BLOB_BYTES} byte limit`,
    );
  }
  const id = randomBytes(16).toString("hex");
  const meta: BlobMeta = {
    spaceId,
    mimeType: mimeType || "application/octet-stream",
    name,
    size: bytes.byteLength,
  };
  await store.writeBytes(id, bytes, BLOB_TTL_MS);
  await store.writeJson(metaKey(id), meta, BLOB_TTL_MS);
  return { id, size: bytes.byteLength };
}

/**
 * Returns null when the blob is gone, or when it belongs to another space — the
 * id alone must never be the authorization.
 */
export async function readBlob(spaceId: string, id: string): Promise<StoredBlob | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const meta = await store.readJson<BlobMeta>(metaKey(id));
  if (!meta || meta.spaceId !== spaceId) return null;
  const bytes = await store.readBytes(id);
  if (!bytes) return null;
  return { ...meta, bytes, extension: EXTENSION_BY_MIME_TYPE.get(meta.mimeType) };
}

function asBytes(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "object" && value !== null) {
    const envelope = (value as Record<string, unknown>).__bytes;
    if (typeof envelope === "string") return Buffer.from(envelope, "base64");
  }
  return null;
}

/**
 * Replace every `{ type: "blob", bytes }` in a job's outputs with a stored one
 * carrying a URL. Applied to both ways a run produces its result — `output()`
 * and a workflow script's return value — so neither can leak raw bytes into the
 * run record.
 */
export async function persistOutputBlobs(
  spaceId: string,
  outputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const persisted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    if (record?.type !== "blob") {
      persisted[key] = value;
      continue;
    }
    const bytes = asBytes(record.bytes ?? record.value);
    if (!bytes) {
      throw new Error(`output "${key}" is a blob without bytes`);
    }
    const name = typeof record.name === "string" ? record.name : null;
    const { id, size } = await putBlob(
      spaceId,
      bytes,
      typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream",
      name,
    );
    persisted[key] = {
      type: "blob",
      url: blobUrl(spaceId, id),
      mimeType:
        typeof record.mimeType === "string"
          ? record.mimeType
          : "application/octet-stream",
      size,
      ...(name ? { name } : {}),
    };
  }
  return persisted;
}

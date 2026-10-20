/**
 * Git LFS for a repository: the batch API plus basic-transfer object routes.
 * Objects live under the repository's storage prefix, so they share its access
 * rules and go when it is deleted.
 */

import { createHash } from "node:crypto";
import type { BlobStore } from "#files/storage.ts";
import { repoPrefix } from "./state.ts";

const LFS_TYPE = "application/vnd.git-lfs+json";

export type LfsOperation = "upload" | "download";

export interface LfsPointer {
  oid: string;
  size: number;
}

export interface LfsBatchRequest {
  operation: LfsOperation;
  objects: LfsPointer[];
}

export function isLfsOid(oid: string): boolean {
  return /^[0-9a-f]{64}$/.test(oid);
}

function lfsObjectPath(documentId: string, oid: string): string {
  return `${repoPrefix(documentId)}/lfs/${oid.slice(0, 2)}/${oid}`;
}

export function lfsResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": LFS_TYPE },
  });
}

/** The request body, or null when it is not a batch request this server can serve. */
export function parseLfsBatch(body: unknown): LfsBatchRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { operation, objects, transfers, hash_algo } = body as Record<string, unknown>;
  if (operation !== "upload" && operation !== "download") return null;
  if (!Array.isArray(objects)) return null;
  if (Array.isArray(transfers) && !transfers.includes("basic")) return null;
  if (hash_algo !== undefined && hash_algo !== "sha256") return null;
  const pointers: LfsPointer[] = [];
  for (const object of objects) {
    const { oid, size } = (object ?? {}) as Record<string, unknown>;
    if (typeof oid !== "string" || !isLfsOid(oid)) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    pointers.push({ oid, size });
  }
  return { operation, objects: pointers };
}

/**
 * Answer a batch request with basic-transfer actions under `objectsUrl`.
 * The caller's credentials ride along, so the transfer is authorized like the batch.
 */
export async function answerLfsBatch(
  storage: BlobStore,
  spaceId: string,
  documentId: string,
  request: LfsBatchRequest,
  objectsUrl: string,
  authorization: string | null,
): Promise<Response> {
  const header = authorization ? { Authorization: authorization } : undefined;
  const objects = await Promise.all(
    request.objects.map(async ({ oid, size }) => {
      const stored = await storage.stat(spaceId, lfsObjectPath(documentId, oid));
      const action = { href: `${objectsUrl}/${oid}`, header };
      if (request.operation === "upload") {
        if (stored?.size === size) return { oid, size };
        return { oid, size, actions: { upload: action } };
      }
      if (!stored)
        return { oid, size, error: { code: 404, message: "Object not found" } };
      return { oid, size: stored.size, actions: { download: action } };
    }),
  );
  return lfsResponse(200, { transfer: "basic", objects, hash_algo: "sha256" });
}

/** Store an uploaded object, refusing bytes that do not hash to `oid`. */
export async function putLfsObject(
  storage: BlobStore,
  spaceId: string,
  documentId: string,
  oid: string,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const hash = createHash("sha256");
  let mismatch = false;
  // Erroring the stream at its end aborts the write before anything lands under the oid.
  const verified = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (hash.digest("hex") === oid) return;
        mismatch = true;
        controller.error(new Error(`LFS object does not hash to ${oid}`));
      },
    }),
  );
  try {
    await storage.putStream(spaceId, lfsObjectPath(documentId, oid), verified);
  } catch (error) {
    if (!mismatch) throw error;
    return lfsResponse(422, { message: "Object content does not match its oid" });
  }
  return new Response(null, { status: 200 });
}

export async function getLfsObject(
  storage: BlobStore,
  spaceId: string,
  documentId: string,
  oid: string,
): Promise<Response> {
  const key = lfsObjectPath(documentId, oid);
  const stored = await storage.stat(spaceId, key);
  const body = stored && (await storage.readStream(spaceId, key));
  if (!stored || !body) return lfsResponse(404, { message: "Object not found" });
  // An explicit length: without it Bun chunks large bodies and nginx waits for a terminator.
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stored.size),
    },
  });
}

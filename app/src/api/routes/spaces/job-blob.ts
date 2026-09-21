/**
 * GET /api/v1/spaces/:spaceId/jobs/blobs/:blobId
 *
 * Serves a binary job output. A run that declares `{ type: "blob", bytes }`
 * gets back a URL pointing here, so the bytes reach the browser as bytes
 * instead of as base64 inside the run's JSON.
 *
 * Auth: user session with viewer access to the space. The id is unguessable but
 * is never the authorization — the stored blob has to belong to this space.
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { notFoundResponse, requireParam, requireUser, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { readBlob } from "#jobs/outputBlobs.ts";
import { servedFileSecurityHeaders } from "#utils/csp.ts";

/**
 * Get a job output blob
 *
 * @tag Jobs
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const blobId = requireParam(context.var.params, "blobId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const blob = await readBlob(spaceId, blobId);
    if (!blob) return notFoundResponse("Blob");

    return new Response(new Uint8Array(blob.bytes), {
      headers: {
        ...servedFileSecurityHeaders(blob.extension, blob.name),
        "Content-Type": blob.extension ? blob.mimeType : "application/octet-stream",
        "Content-Length": String(blob.bytes.byteLength),
        // Immutable: a blob id names one set of bytes, and a job that produces
        // new bytes publishes them under a new id.
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  }, "Failed to read job blob");

import { eq } from "drizzle-orm";
import {
  authenticateDocumentAccess,
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { matchesWeak } from "#api/conditional.ts";
import { requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { getFileIndexEntry } from "#db/space/files.ts";
import { mimeTypeForExtension } from "#files/fileTypes.ts";
import { getFileStorage } from "#files/storage.ts";
import { parseTransformParams, serveTransformed } from "#files/transforms.ts";
import { isSafeUploadPath } from "#files/uploads.ts";
import { appLogger } from "#observability/logger.ts";
import { servedFileSecurityHeaders } from "#utils/csp.ts";

/**
 * Download an uploaded file
 *
 * @tag Files
 * @jobToken
 * @param path Storage path of the file.
 * @media any
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const path = requireParam(context.var.params, "path");

      // Security: Validate path to prevent traversal and malformed paths
      if (!isSafeUploadPath(path)) {
        return new Response("Invalid path", { status: 400 });
      }

      // The document an upload hangs off is what authorizes it: a public share,
      // a resource grant and an archive all reach the file through its document
      // and not through a space role. A file that belongs to none — a workflow
      // artifact, say — keeps the space check.
      const indexed = await getFileIndexEntry(spaceId, path);
      const documentId = indexed?.documentId ?? null;
      if (documentId) {
        await authenticateDocumentAccess(
          context.var.credentials,
          spaceId,
          documentId,
          Permission.VIEWER,
          { shareLinks: true },
        );
      } else {
        await authenticateSpaceAccess(
          context.var.credentials,
          spaceId,
          Permission.VIEWER,
        );
      }

      // Get file extension from the path
      const extension = path.split(".").pop()?.toLowerCase();
      if (!extension) {
        return new Response("Missing file extension", { status: 400 });
      }

      const mimeType = mimeTypeForExtension(extension);
      const storage = getFileStorage();

      // If transform params are present, serve via the transform+cache path.
      // This bypasses redirectUrl so the server can read, transform, and cache
      // the result locally regardless of the storage backend.
      const transformParams = parseTransformParams(
        new URL(context.req.url).searchParams,
        extension,
      );
      if (transformParams) {
        return serveTransformed(spaceId, path, transformParams, storage);
      }

      // Object storage adapters can redirect to their own CDN URL
      const redirect = await storage.redirectUrl?.(spaceId, path);
      if (redirect) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: redirect,
            "Cache-Control": "private, max-age=3600",
          },
        });
      }

      // Through the adapter, not the filesystem: the bytes may not be local,
      // and a range must be asked for rather than seeked to. Containment of the
      // key is the adapter's own business now.
      const info = await storage.stat(spaceId, path);
      if (!info) {
        return new Response("File not found", { status: 404 });
      }
      const fileSize = info.size;

      // A stored object never changes under its key — uploads are content
      // addressed — so a matching validator can always answer 304, and the
      // browser stops re-fetching whole images and videos once its cache entry
      // goes stale.
      const ifNoneMatch = context.req.raw.headers.get("if-none-match");
      if (ifNoneMatch && matchesWeak(ifNoneMatch, info.etag)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: info.etag, "Cache-Control": "private, max-age=3600" },
        });
      }

      const baseHeaders: Record<string, string> = {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=3600",
        // Range support is required for video playback (Safari probes with
        // a byte-range request and refuses to play without a 206 response).
        "Accept-Ranges": "bytes",
        ETag: info.etag,
        // Prevent stored XSS: force download for active types (svg/html),
        // disallow MIME sniffing, and sandbox any rendered content.
        // The stored key is a content hash, so without the uploaded name a
        // download saves as one. The name is advisory: it does not affect the
        // inline/attachment decision, which is a security control.
        ...servedFileSecurityHeaders(extension, indexed?.originalName),
      };

      const rangeHeader = context.req.raw.headers.get("range");
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        const start = match?.[1]
          ? Number(match[1])
          : match?.[2]
            ? Math.max(0, fileSize - Number(match[2]))
            : Number.NaN;
        const end =
          match?.[1] && match[2]
            ? Math.min(Number(match[2]), fileSize - 1)
            : fileSize - 1;

        if (!match || Number.isNaN(start) || start >= fileSize || start > end) {
          return new Response("Range not satisfiable", {
            status: 416,
            headers: {
              "Content-Range": `bytes */${fileSize}`,
              "Cache-Control": "private, max-age=3600",
            },
          });
        }

        const stream = await storage.readStream(spaceId, path, { start, end });
        if (!stream) {
          return new Response("File not found", { status: 404 });
        }
        return new Response(stream, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }

      const stream = await storage.readStream(spaceId, path);
      if (!stream) {
        return new Response("File not found", { status: 404 });
      }
      return new Response(stream, {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(fileSize),
        },
      });
    },
    {
      fallbackMessage: "Failed to serve file",
      onError: (error) => {
        appLogger.error("File serve error", { error });
        return new Response("Failed to serve file", { status: 500 });
      },
    },
  );

/**
 * Delete an uploaded file
 *
 * @tag Files
 * @jobToken
 * @param path Storage path of the file.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const path = requireParam(context.var.params, "path");

      if (!isSafeUploadPath(path)) {
        return new Response("Invalid path", { status: 400 });
      }

      const documentId = (await getFileIndexEntry(spaceId, path))?.documentId ?? null;
      await authenticateJobTokenOrSpaceRole(
        context.var.credentials,
        spaceId,
        Permission.EDITOR,
        documentId ? { type: ResourceType.DOCUMENT, id: documentId } : undefined,
      );

      // Remove from storage (idempotent) and drop the ephemeral index row
      await getFileStorage().delete(spaceId, path);
      const { db } = await openSpaceStore(spaceId);
      await db.delete(fileTable).where(eq(fileTable.path, path));

      return new Response(null, { status: 204 });
    },
    {
      fallbackMessage: "Failed to delete file",
      onError: (error) => {
        appLogger.error("File delete error", { error });
        return new Response("Failed to delete file", { status: 500 });
      },
    },
  );

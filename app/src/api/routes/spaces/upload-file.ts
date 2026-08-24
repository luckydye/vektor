import { eq } from "drizzle-orm";
import {
  authenticateDocumentAccess,
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getSpaceDb } from "#db/client/db.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { getFileDocumentId } from "#db/space/files.ts";
import { getFileStorage } from "#files/storage.ts";
import { parseTransformParams, serveTransformed } from "#files/transforms.ts";
import { isSafeUploadPath } from "#files/uploads.ts";
import { appLogger } from "#observability/logger.ts";
import { servedFileSecurityHeaders } from "#utils/csp.ts";

const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Videos
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  // Documents
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  // Text
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  // Archive
  zip: "application/zip",
  // 3D models
  obj: "model/obj",
};

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
      const documentId = await getFileDocumentId(spaceId, path);
      if (documentId) {
        await authenticateDocumentAccess(
          context.var.credentials,
          spaceId,
          documentId,
          Permission.VIEWER,
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

      const mimeType = MIME_TYPES[extension] || "application/octet-stream";

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
        return Response.redirect(redirect, 302);
      }

      // Through the adapter, not the filesystem: the bytes may not be local,
      // and a range must be asked for rather than seeked to. Containment of the
      // key is the adapter's own business now.
      const info = await storage.stat(spaceId, path);
      if (!info) {
        return new Response("File not found", { status: 404 });
      }
      const fileSize = info.size;

      const baseHeaders: Record<string, string> = {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
        // Range support is required for video playback (Safari probes with
        // a byte-range request and refuses to play without a 206 response).
        "Accept-Ranges": "bytes",
        // Prevent stored XSS: force download for active types (svg/html),
        // disallow MIME sniffing, and sandbox any rendered content.
        ...servedFileSecurityHeaders(extension),
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
            headers: { "Content-Range": `bytes */${fileSize}` },
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

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const path = requireParam(context.var.params, "path");

      if (!isSafeUploadPath(path)) {
        return new Response("Invalid path", { status: 400 });
      }

      const documentId = await getFileDocumentId(spaceId, path);
      await authenticateJobTokenOrSpaceRole(
        context.var.credentials,
        spaceId,
        Permission.EDITOR,
        documentId ? { type: ResourceType.DOCUMENT, id: documentId } : undefined,
      );

      // Remove from storage (idempotent) and drop the ephemeral index row
      await getFileStorage().delete(spaceId, path);
      const db = await getSpaceDb(spaceId);
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

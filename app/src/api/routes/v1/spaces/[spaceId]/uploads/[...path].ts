import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { APIRoute } from "astro";
import { requireParam, withApiErrorHandling } from "#db/api.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { contentDisposition, SERVED_FILE_CSP } from "#utils/servedFiles.ts";
import { getUploadsRoot, isSafeUploadPath, isWithinUploadsRoot } from "#utils/uploads.ts";

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
  // Archive
  zip: "application/zip",
};

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const path = requireParam(context.params, "path");

      await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");

      // Security: Validate path to prevent traversal and malformed paths
      if (!isSafeUploadPath(path)) {
        return new Response("Invalid path", { status: 400 });
      }

      // Get file extension from the path
      const extension = path.split(".").pop()?.toLowerCase();
      if (!extension) {
        return new Response("Missing file extension", { status: 400 });
      }

      const mimeType = MIME_TYPES[extension] || "application/octet-stream";

      // Read file from data/uploads/{spaceId}/{path}
      // Path can be "{filename}" or "{documentId}/{filename}"
      const uploadsRoot = getUploadsRoot(spaceId);
      const filePath = resolve(uploadsRoot, path);
      if (!isWithinUploadsRoot(spaceId, filePath)) {
        return new Response("Invalid path", { status: 400 });
      }

      let fileSize: number;
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          return new Response("File not found", { status: 404 });
        }
        fileSize = fileStat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new Response("File not found", { status: 404 });
        }
        throw error;
      }

      const baseHeaders: Record<string, string> = {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
        // Range support is required for video playback (Safari probes with
        // a byte-range request and refuses to play without a 206 response).
        "Accept-Ranges": "bytes",
        // Prevent stored XSS: force download for active types (svg/html),
        // disallow MIME sniffing, and sandbox any rendered content.
        "Content-Disposition": contentDisposition(extension),
        "Content-Security-Policy": SERVED_FILE_CSP,
        "X-Content-Type-Options": "nosniff",
      };

      const rangeHeader = context.request.headers.get("range");
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

        const stream = Readable.toWeb(
          createReadStream(filePath, { start, end }),
        ) as ReadableStream;
        return new Response(stream, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }

      const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
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
        console.error("File serve error:", error);
        return new Response("Failed to serve file", { status: 500 });
      },
    },
  );

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const path = requireParam(context.params, "path");

      await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

      if (!isSafeUploadPath(path)) {
        return new Response("Invalid path", { status: 400 });
      }

      const uploadsRoot = getUploadsRoot(spaceId);
      const filePath = resolve(uploadsRoot, path);
      if (!isWithinUploadsRoot(spaceId, filePath)) {
        return new Response("Invalid path", { status: 400 });
      }

      try {
        await unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new Response("File not found", { status: 404 });
        }
        throw error;
      }

      return new Response(null, { status: 204 });
    },
    {
      fallbackMessage: "Failed to delete file",
      onError: (error) => {
        console.error("File delete error:", error);
        return new Response("Failed to delete file", { status: 500 });
      },
    },
  );

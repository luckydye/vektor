import type { APIRoute } from "astro";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireParam, withApiErrorHandling } from "#db/api.ts";
import {
  getUploadsRoot,
  isSafeUploadPath,
  isWithinUploadsRoot,
} from "../../../../../../utils/uploads.ts";
import { authenticateJobTokenOrSpaceRole } from "../../../_auth.ts";

const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
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

      try {
        const fileBuffer = await readFile(filePath);

        return new Response(fileBuffer, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new Response("File not found", { status: 404 });
        }
        throw error;
      }
    },
    {
      fallbackMessage: "Failed to serve file",
      onError: (error) => {
        console.error("File serve error:", error);
        return new Response("Failed to serve file", { status: 500 });
      },
    },
  );

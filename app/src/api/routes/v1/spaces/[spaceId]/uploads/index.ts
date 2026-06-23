import { createHash } from "node:crypto";
import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getSpaceDb } from "#db/db.ts";
import { updateDocumentEmbedding } from "#db/documents.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadIdPart } from "#files/uploads.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

const ALLOWED_TYPES = [
  // Images
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Videos
  "video/mp4",
  "video/webm",
  "video/quicktime", // .mov
  "video/x-m4v",
  "video/ogg",
  // Documents
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-excel", // .xls
  "application/msword", // .doc
  "text/markdown", // .md
  "text/plain", // .txt (fallback for .md)
  "text/csv", // .csv
  "application/pdf", // .pdf
  "application/zip", // .zip
  "application/x-zip-compressed", // .zip (alternative)
  "application/json", // .json
  "application/xml", // .xml
  "text/xml", // .xml (alternative)
  "model/obj", // .obj
];

const ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
  "docx",
  "doc",
  "pdf",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "csv",
  "zip",
  "md",
  "txt",
  "json",
  "xml",
  "obj",
];
const MAX_FILE_SIZE = 250 * 1024 * 1024; // 250MB for documents

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const user = requireUser(context);
      await verifySpaceRole(spaceId, user.id, "viewer");

      const storage = getFileStorage();
      const files = await storage.list(spaceId);

      return jsonResponse(
        { files: files.map((f) => ({ ...f, url: storage.url(spaceId, f.key) })) },
        200,
      );
    },
    {
      fallbackMessage: "Failed to list uploads",
      onError: (error) => {
        console.error("List uploads error:", error);
        return errorResponse("Failed to list uploads", 500);
      },
    },
  );

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
      const isJobAuth = auth.type === "job";

      // Parse the form data
      const formData = await context.request.formData();
      const file = formData.get("file") as Blob | null;
      const originalName =
        (formData.get("filename") as string | null) ??
        (file instanceof File ? file.name : null) ??
        "upload";
      const documentId = formData.get("documentId") as string | null;

      if (!file) {
        return badRequestResponse("No file provided");
      }

      if (documentId !== null && !isSafeUploadIdPart(documentId)) {
        return badRequestResponse("Invalid documentId");
      }

      // Job uploads (authenticated via X-Job-Token) are trusted server-side code;
      // skip the type allowlist. User uploads are validated as before.
      if (!isJobAuth) {
        const extension = originalName.split(".").pop()?.toLowerCase() || "";
        const isAllowedExtension = ALLOWED_EXTENSIONS.includes(extension);
        const isAllowedMime = ALLOWED_TYPES.includes(file.type);

        if (!isAllowedExtension && !isAllowedMime) {
          return badRequestResponse(
            `Invalid file type. Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}`,
          );
        }
      }

      // Validate file size (user uploads only; job uploads are trusted)
      if (!isJobAuth && file.size > MAX_FILE_SIZE) {
        return badRequestResponse(
          `File size exceeds maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Content-addressable key: SHA-256 hash with 2-char prefix directory
      const hash = createHash("sha256").update(buffer).digest("hex");
      const fileExtension = originalName.split(".").pop()?.toLowerCase() ?? "bin";
      const key = `${hash.slice(0, 2)}/${hash}.${fileExtension}`;

      const storage = getFileStorage();
      const url = await storage.put(spaceId, key, buffer, file.type || undefined);

      // Extract text synchronously (buffer is in memory already)
      const extractedText = extractFileTextFromBuffer(
        buffer,
        originalName,
        file.type || undefined,
      );

      // Insert full metadata to file table for all uploads
      const db = await getSpaceDb(spaceId);
      await db
        .insert(fileTable)
        .values({
          path: key,
          documentId: documentId ?? null,
          originalName,
          mimeType: file.type || null,
          url,
          updatedAt: new Date(),
          extractedText,
        })
        .onConflictDoUpdate({
          target: fileTable.path,
          set: {
            documentId: documentId ?? null,
            originalName,
            mimeType: file.type || null,
            url,
            updatedAt: new Date(),
            extractedText,
          },
        });

      if (documentId) {
        // Re-index the parent document (reads from file table, no FS scan)
        updateDocumentEmbedding(spaceId, documentId).catch((err) => {
          console.warn("Failed to re-index document after upload:", err);
        });
      }

      return jsonResponse({ url, key }, 200);
    },
    {
      fallbackMessage: "Failed to upload file",
      onError: (error) => {
        console.error("Upload file error:", error);
        return errorResponse("Failed to upload file", 500);
      },
    },
  );

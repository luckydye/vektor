import { createHash } from "node:crypto";
import type { ApiRouteHandler } from "#api/server/types.ts";
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
import { file as fileTable } from "#db/schema/space.ts";
import { updateDocumentEmbedding } from "#db/search.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadIdPart } from "#files/uploads.ts";
import { appLogger } from "#observability/logger.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

const MAX_FILE_SIZE = 1280 * 1024 * 1024; // 1.25GB

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
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
        appLogger.error("List uploads error", { error });
        return errorResponse("Failed to list uploads", 500);
      },
    },
  );

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
      const isJobAuth = auth.type === "job";

      // Parse the form data
      const formData = await context.req.raw.formData();
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
          appLogger.warn("Failed to re-index document after upload", { error: err });
        });
      }

      return jsonResponse({ url, key }, 200);
    },
    {
      fallbackMessage: "Failed to upload file",
      onError: (error) => {
        appLogger.error("Upload file error", { error });
        return errorResponse("Failed to upload file", 500);
      },
    },
  );

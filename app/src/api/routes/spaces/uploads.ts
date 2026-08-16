import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  spaceAccessToViewer,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  parseFormBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getSpaceDb } from "#db/client/db.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { filterAccessibleFiles, getFileDocumentIds } from "#db/space/files.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadIdPart } from "#files/uploads.ts";
import { appLogger } from "#observability/logger.ts";
import { updateDocumentEmbedding } from "#search/indexing.ts";

const MAX_FILE_SIZE = 1280 * 1024 * 1024; // 1.25GB

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      // Admitted on a resource grant alone, since every row is then filtered
      // against the documents it reaches.
      const access = await authenticateSpaceAccess(context, spaceId, Permission.VIEWER, {
        allowResourceGrants: true,
      });

      const storage = getFileStorage();
      const files = await storage.list(spaceId);

      const parentIds = await getFileDocumentIds(
        spaceId,
        files.map((f) => f.key),
      );
      const visible = await filterAccessibleFiles(
        spaceId,
        files.map((f) => ({ ...f, documentId: parentIds.get(f.key) ?? null })),
        spaceAccessToViewer(access),
      );

      return jsonResponse(
        {
          files: visible.map(({ documentId, ...f }) => ({
            ...f,
            url: storage.url(spaceId, f.key),
          })),
        },
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

      // The real gate is below, on the document the body names. This one runs
      // first so a caller with no editor reach into the space at all cannot
      // stream a gigabyte into the parser.
      await authenticateSpaceAccess(context, spaceId, Permission.EDITOR, {
        allowResourceGrants: true,
      });

      // Parse the form data
      const formData = await parseFormBody(context.req.raw);
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

      // Editor on the document being attached to, or on the space itself for
      // an upload that belongs to no document.
      const auth = await authenticateJobTokenOrSpaceRole(
        context,
        spaceId,
        Permission.EDITOR,
        documentId ? { type: ResourceType.DOCUMENT, id: documentId } : undefined,
      );
      const isJobAuth = auth.type === "job";

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
            // Keys are content hashes, so uploading the same bytes again lands
            // on someone else's row. The first document to claim it keeps it:
            // that document's ACL is what serves the file, and a later upload
            // must not be able to move an image out from under the document
            // already showing it. Only an unclaimed row takes the new parent.
            documentId: sql`COALESCE(${fileTable.documentId}, ${documentId ?? null})`,
            originalName,
            mimeType: file.type || null,
            url,
            updatedAt: new Date(),
            extractedText,
          },
        });

      const store = await openSpaceStore(spaceId);
      if (documentId) {
        // Re-index the parent document (reads from file table, no FS scan)
        updateDocumentEmbedding(store, documentId).catch((err) => {
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

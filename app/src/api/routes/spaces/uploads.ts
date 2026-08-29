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
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { filterAccessibleFiles, getFileIndexEntries } from "#db/space/files.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import {
  readImageDimensions,
  readStoredImageDimensions,
} from "#files/imageDimensions.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadIdPart } from "#files/uploads.ts";
import { appLogger } from "#observability/logger.ts";
import { updateDocumentEmbedding } from "#search/indexing.ts";

/**
 * Files above this are stored without extracting their text. Extraction is
 * synchronous and decompresses the whole document in memory, so it runs only on
 * inputs small enough not to stall the event loop. It bounds the indexing, not
 * the upload: a file over it is stored in full, just not searched by content.
 */
const MAX_TEXT_EXTRACTION_SIZE = 25 * 1024 * 1024;

/** The extension a key is built from, or `bin` for a name that carries none. */
function safeExtension(originalName: string): string {
  const candidate = originalName.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]{1,16}$/.test(candidate) ? candidate : "bin";
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      // Admitted on a resource grant alone, since every row is then filtered
      // against the documents it reaches.
      const access = await authenticateSpaceAccess(
        context.var.credentials,
        spaceId,
        Permission.VIEWER,
        {
          allowResourceGrants: true,
        },
      );

      const storage = getFileStorage();
      const files = await storage.list(spaceId);

      const index = await getFileIndexEntries(
        spaceId,
        files.map((f) => f.key),
      );
      const visible = await filterAccessibleFiles(
        spaceId,
        files.map((f) => {
          // A file on disk with no index row is still a real file; it lists
          // with nulls rather than disappearing.
          const entry = index.get(f.key);
          return {
            ...f,
            documentId: entry?.documentId ?? null,
            originalName: entry?.originalName ?? null,
            mimeType: entry?.mimeType ?? null,
          };
        }),
        spaceAccessToViewer(access),
      );

      // `documentId` is returned rather than stripped: every row here has
      // already been filtered against the document that authorizes it, so
      // naming that document tells the caller nothing it cannot already read.
      // A client listing uploads needs it — and `originalName` — to show a file
      // as anything other than the content hash it is stored under.
      return jsonResponse(
        {
          files: visible.map((f) => ({
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

      // The real gate is below, on the document the query names. This one runs
      // first so a caller with no editor reach into the space at all cannot
      // stream a gigabyte at the disk.
      await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.EDITOR, {
        allowResourceGrants: true,
      });

      // The file is the request body, not a multipart part: the body streams
      // straight to storage, so an upload costs a chunk of memory rather than
      // its own size however large it is.
      const query = new URL(context.req.raw.url).searchParams;
      const originalName = query.get("filename") ?? "upload";
      const documentId = query.get("documentId");
      const body = context.req.raw.body;

      if (!body) {
        return badRequestResponse("No file provided");
      }

      if (documentId !== null && !isSafeUploadIdPart(documentId)) {
        return badRequestResponse("Invalid documentId");
      }

      // Editor on the document being attached to, or on the space itself for
      // an upload that belongs to no document.
      await authenticateJobTokenOrSpaceRole(
        context.var.credentials,
        spaceId,
        Permission.EDITOR,
        documentId ? { type: ResourceType.DOCUMENT, id: documentId } : undefined,
      );

      const contentType = context.req.raw.headers.get("content-type") ?? undefined;
      const storage = getFileStorage();
      const { key, url, size } = await storage.putHashed(
        spaceId,
        safeExtension(originalName),
        body,
        contentType,
      );

      // Read back rather than keeping the bytes: only files small enough to
      // extract are held in memory at all.
      const stored =
        size > MAX_TEXT_EXTRACTION_SIZE ? null : await storage.read(spaceId, key);
      const extractedText = stored
        ? extractFileTextFromBuffer(stored, originalName, contentType)
        : null;

      // Dimensions come from the file's first bytes, so an image too large to
      // hold still gets them — and nothing has to fetch it again later to lay
      // out the page that shows it.
      const dimensions = stored
        ? readImageDimensions(stored)
        : await readStoredImageDimensions(storage, spaceId, key);

      // Insert full metadata to file table for all uploads
      const store = await openSpaceStore(spaceId);
      await store.db
        .insert(fileTable)
        .values({
          path: key,
          documentId: documentId ?? null,
          originalName,
          mimeType: contentType ?? null,
          size,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
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
            mimeType: contentType ?? null,
            size,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            url,
            updatedAt: new Date(),
            extractedText,
          },
        });

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

import { authenticateDocumentAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument } from "#db/space/documents.ts";
import {
  PropertyRenameConflictError,
  renameDatabaseColumn,
} from "#db/space/properties.ts";
import {
  canonicalPropertyKey,
  InvalidDocumentPropertyPatchError,
  ReservedDocumentPropertyKeyError,
} from "#documents/properties.ts";

/**
 * Rename a database column, on every row and in the database's `_schema`
 *
 * @tag Documents
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const id = requireParam(context.var.params, "documentId");
      const { aclUserId } = await authenticateDocumentAccess(
        context.var.credentials,
        spaceId,
        id,
        Permission.EDITOR,
      );

      const store = await openSpaceStore(spaceId);
      const database = await getDocument(store, id);
      if (database?.type !== "database") throw notFoundResponse("Database");

      const { from, to } = await parseJsonBody<{ from?: unknown; to?: unknown }>(
        context.req.raw,
      );
      if (typeof from !== "string" || typeof to !== "string" || !to.trim()) {
        throw badRequestResponse("Both `from` and a non-empty `to` are required");
      }
      const toKey = canonicalPropertyKey(to);
      if (toKey === "title" || toKey.startsWith("_")) {
        throw badRequestResponse(`"${to.trim()}" cannot be used as a column name`);
      }

      const schema = await renameDatabaseColumn(
        store,
        id,
        from,
        to.trim(),
        aclUserId ?? undefined,
      );
      return jsonResponse({ schema: schema ?? null });
    },
    {
      fallbackMessage: "Failed to rename column",
      onError(error) {
        if (error instanceof PropertyRenameConflictError) {
          return errorResponse(error.message, 409);
        }
        if (
          error instanceof InvalidDocumentPropertyPatchError ||
          error instanceof ReservedDocumentPropertyKeyError
        ) {
          return badRequestResponse(error.message);
        }
      },
    },
  );

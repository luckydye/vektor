import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { requestCredentials } from "#api/acl.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument, updateDocument } from "#db/space/documents.ts";
import { applyEditOperations, parseEditOperations } from "#documents/edit.ts";
import { documentIsReadonly } from "#documents/types.ts";
import { transformDocumentContent } from "#realtime/yjsRooms.ts";
import { sanitizeDocumentHtml } from "#utils/html.ts";

/**
 * Applies partial edit operations to a document through the collaboration
 * channel. When the document is open in an editor, the edit is applied to the
 * live Yjs doc and broadcast to connected clients, so it merges with
 * concurrent changes instead of overwriting them.
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");

    const store = await openSpaceStore(spaceId);
    const existingDoc = await getDocument(store, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    const auth = await authenticateJobTokenOrSpaceRole(
      requestCredentials(context),
      spaceId,
      Permission.EDITOR,
      {
        type: ResourceType.DOCUMENT,
        id,
      },
    );
    // Parity with PATCH/DELETE on the sibling route: a user session must also
    // hold editor on the document itself, not just on the space.
    if (auth.type === "user") {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        auth.user.id,
        Permission.EDITOR,
      );
    }

    if (documentIsReadonly(existingDoc)) {
      throw forbiddenResponse("Cannot edit readonly document");
    }

    const body = await parseJsonBody<{ operations?: unknown }>(context.req.raw);

    let result: Awaited<ReturnType<typeof transformDocumentContent>>;
    try {
      const operations = parseEditOperations(body.operations);
      result = await transformDocumentContent(
        spaceId,
        id,
        (content) => sanitizeDocumentHtml(applyEditOperations(content, operations)),
        operations,
      );
    } catch (error) {
      throw badRequestResponse(error instanceof Error ? error.message : "Invalid edit");
    }

    if (!result) {
      throw notFoundResponse("Document");
    }

    const document = await updateDocument(store, id, result.content);
    return jsonResponse({ document, live: result.live });
  }, "Failed to edit document");

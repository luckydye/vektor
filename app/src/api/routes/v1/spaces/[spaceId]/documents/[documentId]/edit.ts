import type { APIRoute } from "astro";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocument, updateDocument } from "#db/documents.ts";
import { applyEditOperations, parseEditOperations } from "#utils/documentEdit.ts";
import { transformDocumentContent } from "#utils/yjsRooms.ts";
import { readOnlyDocumentTypes } from "#utils/documentTypes.ts";
import { stripScriptTags } from "#utils/utils.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { ResourceType } from "#db/acl.ts";

/**
 * Applies partial edit operations to a document through the collaboration
 * channel. When the document is open in an editor, the edit is applied to the
 * live Yjs doc and broadcast to connected clients, so it merges with
 * concurrent changes instead of overwriting them.
 */
export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");

    const existingDoc = await getDocument(spaceId, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor", {
      type: ResourceType.DOCUMENT,
      id,
    });
    const isJobRequest = auth.type === "job";
    const userId = auth.type === "user" ? auth.user.id : auth.userId;

    if (
      !isJobRequest &&
      (existingDoc.readonly || readOnlyDocumentTypes.includes(existingDoc.type ?? ""))
    ) {
      throw forbiddenResponse("Cannot edit readonly document");
    }

    const body = await parseJsonBody<{ operations?: unknown }>(context.request);

    let result: Awaited<ReturnType<typeof transformDocumentContent>>;
    try {
      const operations = parseEditOperations(body.operations);
      result = await transformDocumentContent(spaceId, id, (content) =>
        stripScriptTags(applyEditOperations(content, operations)),
      );
    } catch (error) {
      throw badRequestResponse(error instanceof Error ? error.message : "Invalid edit");
    }

    if (!result) {
      throw notFoundResponse("Document");
    }

    const document = await updateDocument(
      spaceId,
      id,
      result.content,
      userId ?? undefined,
    );
    return jsonResponse({ document, live: result.live });
  }, "Failed to edit document");

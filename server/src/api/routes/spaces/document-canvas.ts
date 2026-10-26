import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import {
  applyCanvasOperations,
  CanvasEditError,
  type CanvasEditResult,
  describeCanvas,
} from "#canvas/agent/format.ts";
import { parseSnapshot } from "#canvas/agent/model.ts";
import { serverFonts } from "#canvas/raster/text.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument, getDocumentContent, updateDocument } from "#db/space/documents.ts";
import { createRevision } from "#db/space/revisions.ts";
import { documentIsReadonly } from "#documents/types.ts";
import { getLiveDocumentContent, transformDocumentContent } from "#realtime/yjsRooms.ts";

/** The canvas document and the caller, checked for `permission` on it. */
export async function canvasRequest(context: ApiContext, permission: Permission) {
  const spaceId = requireParam(context.var.params, "spaceId");
  const id = requireParam(context.var.params, "documentId");
  const store = await openSpaceStore(context.var.platform, spaceId);
  const document = await getDocument(store, id);
  if (!document) throw notFoundResponse("Document");
  if (document.type !== "canvas") throw badRequestResponse("Not a canvas document");
  const auth = await authenticateJobTokenOrSpaceRole(
    store.platform,
    context.var.credentials,
    spaceId,
    permission,
    { type: ResourceType.DOCUMENT, id },
  );
  if (auth.type === "user") {
    await verifyAccess(store.platform, spaceId, { type: ResourceType.DOCUMENT, id }, auth.user.id, permission);
  }
  const content = getLiveDocumentContent(spaceId, id, document.type, (await getDocumentContent(store, id)) ?? "");
  return { spaceId, id, store, document, auth, snapshot: parseSnapshot(content) };
}

/**
 * Read a canvas as elements
 *
 * The live canvas as flat elements addressed by id, positioned relative to the
 * frame each sits in: the representation the agent tools edit.
 *
 * @tag Documents
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { snapshot } = await canvasRequest(context, Permission.VIEWER);
    return jsonResponse(describeCanvas(snapshot, await serverFonts()));
  }, "Failed to read canvas");

/**
 * Edit a canvas by element
 *
 * Applies add, update, delete, front, back and diagram operations through the
 * collaboration channel, and reports warnings about the resulting layout.
 *
 * @tag Documents
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { spaceId, id, store, document, auth } = await canvasRequest(context, Permission.EDITOR);
    if (documentIsReadonly(document)) throw forbiddenResponse("Cannot edit readonly document");
    const body = await parseJsonBody<{ operations?: unknown }>(context.req.raw);
    const faces = await serverFonts();
    let outcome: CanvasEditResult | null = null;
    let written: Awaited<ReturnType<typeof transformDocumentContent>>;
    try {
      written = await transformDocumentContent(context.var.platform, spaceId, id, (content) => {
        const { snapshot, result } = applyCanvasOperations(parseSnapshot(content), body.operations, faces);
        outcome = result;
        return JSON.stringify(snapshot);
      });
    } catch (error) {
      if (error instanceof CanvasEditError) throw badRequestResponse(error.message);
      throw error;
    }
    if (!written || !outcome) throw notFoundResponse("Document");
    const updated = await updateDocument(store, id, written.content);
    if (!updated.ok) throw notFoundResponse("Document");
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (userId) await createRevision(store, id, written.content, userId, { message: "Canvas edited" });
    return jsonResponse(outcome);
  }, "Failed to edit canvas");

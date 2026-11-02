import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  errorResponse,
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
  describeCanvas,
} from "#canvas/agent/format.ts";
import type { StoredSnapshot } from "#canvas/agent/model.ts";
import type { BBox } from "#canvas/document/format/records.ts";
import { serverFonts } from "#canvas/raster/text.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { readCanvasSnapshot } from "#db/space/canvasSnapshot.ts";
import {
  assertCanCatchUp,
  CanvasCatchUpError,
  type CanvasLoadQuery,
  canvasWorkingSet,
  loadCanvas,
} from "#db/space/canvasStore.ts";
import { getDocument } from "#db/space/documents.ts";
import { documentIsReadonly } from "#documents/types.ts";
import { writeCanvasSnapshot } from "#realtime/canvasEdits.ts";
import { showAgentOnCanvas } from "#realtime/yjsRooms.ts";

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
    await verifyAccess(
      store.platform,
      spaceId,
      { type: ResourceType.DOCUMENT, id },
      auth.user.id,
      permission,
    );
  }
  return {
    spaceId,
    id,
    store,
    document,
    auth,
    /** The whole canvas; describe and render hold every object, as they did before. */
    snapshot: async () =>
      (await readCanvasSnapshot(store, id)) as unknown as StoredSnapshot,
  };
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
    return jsonResponse(describeCanvas(await snapshot(), await serverFonts()));
  }, "Failed to read canvas");

function parseLoadQuery(body: Record<string, unknown>): CanvasLoadQuery {
  const query: CanvasLoadQuery = {};
  if (body.view !== undefined) {
    const view = body.view;
    if (
      !Array.isArray(view) ||
      view.length !== 4 ||
      !view.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw badRequestResponse("view must be [x0, y0, x1, y1]");
    }
    query.view = view as BBox;
  }
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
      throw badRequestResponse("ids must be a list of strings");
    }
    query.ids = body.ids as string[];
  }
  if (body.since !== undefined) {
    if (typeof body.since !== "number" || typeof body.epoch !== "string") {
      throw badRequestResponse("since needs a number and an epoch");
    }
    query.since = body.since;
    query.epoch = body.epoch;
  }
  return query;
}

/**
 * Load canvas objects
 *
 * Streams `application/vnd.vektor.canvas` records: the objects in `view`, the
 * named `ids`, every record after `since` in `epoch` (409 when that cannot be
 * answered), or everything for an empty query.
 *
 * @tag Documents
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { store, id } = await canvasRequest(context, Permission.VIEWER);
    const query = parseLoadQuery(await parseJsonBody(context.req.raw));
    const ws = await canvasWorkingSet(store, id);
    try {
      assertCanCatchUp(ws, query);
    } catch (error) {
      if (error instanceof CanvasCatchUpError) return errorResponse(error.message, 409);
      throw error;
    }
    const records = loadCanvas(ws, query);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await records.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await records.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/vnd.vektor.canvas",
        "Cache-Control": "no-store",
      },
    });
  }, "Failed to load canvas");

/**
 * Edit a canvas by element
 *
 * Applies add, update, delete, front, back and diagram operations as the
 * server's writes, and reports warnings about the resulting layout. Returns
 * once the edit is durable.
 *
 * @tag Documents
 * @jobToken
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { spaceId, id, document, snapshot } = await canvasRequest(
      context,
      Permission.EDITOR,
    );
    if (documentIsReadonly(document))
      throw forbiddenResponse("Cannot edit readonly document");
    const body = await parseJsonBody<{ operations?: unknown }>(context.req.raw);
    const faces = await serverFonts();
    let edited: ReturnType<typeof applyCanvasOperations>;
    try {
      edited = applyCanvasOperations(await snapshot(), body.operations, faces);
    } catch (error) {
      if (error instanceof CanvasEditError) throw badRequestResponse(error.message);
      throw error;
    }
    const changed = await writeCanvasSnapshot(
      context.var.platform,
      spaceId,
      id,
      edited.snapshot,
    );
    showAgentOnCanvas(
      context.var.platform,
      spaceId,
      id,
      edited.snapshot.shapes.filter((shape) => changed.includes(shape.id)),
    );
    return jsonResponse(edited.result);
  }, "Failed to edit canvas");

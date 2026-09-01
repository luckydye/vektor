import { authenticateSpaceAccess, spaceAccessToViewer } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  jsonResponse,
  parseQueryInt,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listDocumentChanges } from "#db/space/changes.ts";

/**
 * Read what changed since a position in the space's write order
 *
 * The pull half of sync. A consumer holds one number, asks for everything
 * above it, and stores the `nextSince` it gets back — so a run that dies
 * halfway resumes where it stopped rather than starting over, and replaying a
 * page it already applied changes nothing.
 *
 * Deleted documents arrive as entries with `deleted: true`. They are the reason
 * this exists: a scan of documents that exist can never mention one that does
 * not, so without them a consumer cannot tell a deletion from silence.
 *
 * @tag Documents
 * @jobToken
 * @query since:number The position already applied. Omit or 0 for the whole space.
 * @query limit:number Page size, 1-500.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");

    // No resource grants: this walks the whole space's write order, including
    // tombstones that no per-document check can filter, so reaching it takes a
    // role in the space rather than a grant on something inside it.
    const access = await authenticateSpaceAccess(
      context.var.credentials,
      spaceId,
      Permission.VIEWER,
      { allowResourceGrants: false },
    );

    const searchParams = new URL(context.req.url).searchParams;
    const since = parseQueryInt(searchParams, "since", { defaultValue: 0, min: 0 });
    const limit = parseQueryInt(searchParams, "limit", {
      defaultValue: 100,
      min: 1,
      max: 500,
    });

    const store = await openSpaceStore(spaceId);
    const page = await listDocumentChanges(store, {
      since,
      limit,
      viewer: spaceAccessToViewer(access),
    });

    return jsonResponse(page);
  }, "Failed to read document changes");

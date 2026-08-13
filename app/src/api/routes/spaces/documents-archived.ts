import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/store.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listArchivedDocuments } from "#db/space/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    // The trash is editor territory: an archived document requires `editor` to
    // read, so listing them is not something a space viewer may do.
    await verifySpaceRole(spaceId, user.id, Permission.EDITOR);
    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
      {
        defaultLimit: 50,
        maxLimit: 500,
      },
    );
    const store = await openSpaceStore(spaceId);
    const { documents, nextCursor } = await listArchivedDocuments(
      store,
      { userId: user.id, userGroups: await getUserGroups(user.id) },
      { limit, cursor },
    );
    return jsonResponse({ documents, limit, nextCursor });
  }, "Failed to list archived documents");

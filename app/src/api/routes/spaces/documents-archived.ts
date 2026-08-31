import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
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

/**
 * List the archived documents of a space
 *
 * @tag Documents
 * @paginated
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    // Reading an archived document takes `editor`, so listing them does too.
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );
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

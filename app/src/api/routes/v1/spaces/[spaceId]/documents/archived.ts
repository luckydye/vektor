import type { ApiRouteHandler } from "#api/server/types.ts";
import { getUserGroups } from "#db/acl.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  verifySpaceAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { listArchivedDocuments } from "#db/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceAccess(spaceId, user.id);
    const { limit, offset } = parsePaginationParams(new URL(context.req.url).searchParams, {
      defaultLimit: 50,
      maxLimit: 500,
    });
    const { documents, total } = await listArchivedDocuments(
      spaceId,
      { userId: user.id, userGroups: await getUserGroups(user.id) },
      { limit, offset },
    );
    return jsonResponse({ documents, total, limit, offset });
  }, "Failed to list archived documents");

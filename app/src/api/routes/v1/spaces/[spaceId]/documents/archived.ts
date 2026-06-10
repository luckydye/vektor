import type { APIRoute } from "astro";
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

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceAccess(spaceId, user.id);
    const { limit, offset } = parsePaginationParams(context.url.searchParams, {
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

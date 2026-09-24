import { inArray } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { many } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import {
  DOCUMENT_CONTRIBUTION_AUDIT_EVENTS,
  getAuditLogsForDocument,
} from "#db/space/auditLogs.ts";

/**
 * The accounts that have revised this document
 *
 * @tag Documents
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const currentUser = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      currentUser.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const { rows: logs } = await getAuditLogsForDocument(store, documentId, 1000);

    // Extract unique user IDs from audit logs
    const userIds = new Set<string>();
    for (const log of logs) {
      if (
        log.userId &&
        DOCUMENT_CONTRIBUTION_AUDIT_EVENTS.includes(
          log.event as (typeof DOCUMENT_CONTRIBUTION_AUDIT_EVENTS)[number],
        )
      ) {
        userIds.add(log.userId);
      }
    }

    // If no contributors found, return empty array
    if (userIds.size === 0) {
      return jsonResponse({ contributors: [] });
    }

    // Fetch user information from auth database. Only id/name/image — the
    // client shows the contributor name and an id-seeded avatar; email is PII
    // and is never needed here, so it is not selected or returned.
    const authDb = getAuthDb();
    const userIdsArray = Array.from(userIds);
    const contributors = await many(
      authDb
        .select({
          userId: user.id,
          name: user.name,
          image: user.image,
        })
        .from(user)
        .where(inArray(user.id, userIdsArray)),
    );

    return jsonResponse({ contributors });
  }, "Failed to list contributors");

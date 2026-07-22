import { inArray } from "drizzle-orm";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  DOCUMENT_CONTRIBUTION_AUDIT_EVENTS,
  getAuditLogsForDocument,
} from "#db/auditLogs.ts";
import { getAuthDb, getSpaceDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const currentUser = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, currentUser.id);

    const db = await getSpaceDb(spaceId);
    const { rows: logs } = await getAuditLogsForDocument(db, documentId, 1000);

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
    const contributors = await authDb
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
      })
      .from(user)
      .where(inArray(user.id, userIdsArray))
      .all();

    return jsonResponse({ contributors });
  }, "Failed to list contributors");

import type { APIRoute } from "astro";
import { eq, inArray } from "drizzle-orm";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuditLogsForDocument } from "#db/auditLogs.ts";
import { getAuthDb, getSpaceDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const currentUser = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, currentUser.id);

    const db = await getSpaceDb(spaceId);
    const logs = await getAuditLogsForDocument(db, documentId, 1000);

    // Extract unique user IDs from audit logs
    const userIds = new Set<string>();
    for (const log of logs) {
      if (log.userId) {
        userIds.add(log.userId);
      }
    }

    // If no contributors found, return empty array
    if (userIds.size === 0) {
      return jsonResponse({ contributors: [] });
    }

    // Fetch user information from auth database
    const authDb = getAuthDb();
    const userIdsArray = Array.from(userIds);
    const contributors = await authDb
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(user)
      .where(inArray(user.id, userIdsArray))
      .all();

    return jsonResponse({ contributors });
  }, "Failed to list contributors");

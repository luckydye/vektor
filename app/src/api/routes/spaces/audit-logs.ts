import {
  verifyDocumentAccess,
  verifyFeatureAccess,
  verifySpaceAccess,
} from "#acl/guards.ts";
import { Feature } from "#acl/permissions.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getSpaceDb } from "#db/client/db.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  getAuditLogsForDocument,
  getRecentAuditLogs,
  parseAuditDetails,
} from "#db/space/auditLogs.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = new URL(context.req.url).searchParams.get("documentId");

    if (documentId) {
      await verifyDocumentAccess(spaceId, documentId, user.id);
    } else {
      await verifySpaceAccess(spaceId, user.id);
    }

    // Verify user has audit log viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_AUDIT, user.id);

    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
    );

    const store = await openSpaceStore(spaceId);
    const { rows, nextCursor } = documentId
      ? await getAuditLogsForDocument(store, documentId, limit, cursor)
      : await getRecentAuditLogs(store, limit, cursor);

    const auditLogs = rows.map((log) => ({
      ...log,
      details: parseAuditDetails(log),
    }));

    return jsonResponse({ auditLogs, limit, nextCursor });
  }, "Failed to list space audit logs");

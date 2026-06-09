import type { APIRoute } from "astro";
import { Feature } from "#db/acl.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  verifyFeatureAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuditLogsForDocument, parseAuditDetails } from "#db/auditLogs.ts";
import { getSpaceDb } from "#db/db.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has audit log viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_AUDIT, user.id);

    const { limit, offset } = parsePaginationParams(context.url.searchParams);

    const db = await getSpaceDb(spaceId);
    const { rows, total } = await getAuditLogsForDocument(db, documentId, limit, offset);

    const auditLogs = rows.map((log) => ({
      ...log,
      details: parseAuditDetails(log),
    }));

    return jsonResponse({ auditLogs, total, limit, offset });
  }, "Failed to list document audit logs");

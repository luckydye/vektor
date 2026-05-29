import type { APIRoute } from "astro";
import {
  jsonResponse,
  parseQueryInt,
  requireParam,
  requireUser,
  verifySpaceAccess,
  verifyFeatureAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { Feature } from "#db/acl.ts";
import { getRecentAuditLogs, parseAuditDetails } from "#db/auditLogs.ts";
import { getSpaceDb } from "#db/db.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceAccess(spaceId, user.id);

    // Verify user has audit log viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_AUDIT, user.id);

    const limit = parseQueryInt(context.url.searchParams, "limit", {
      defaultValue: 100,
      min: 1,
      max: 1000,
    });

    const db = await getSpaceDb(spaceId);
    const logs = await getRecentAuditLogs(db, limit);

    const logsWithDetails = logs.map((log) => ({
      ...log,
      details: parseAuditDetails(log),
    }));

    return jsonResponse({ auditLogs: logsWithDetails });
  }, "Failed to list space audit logs");

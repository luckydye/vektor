import { requireSpace, verifyAccess, verifyFeatureAccess } from "#acl/guards.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  getAuditLogsForDocument,
  getRecentAuditLogs,
  parseAuditDetails,
} from "#db/space/auditLogs.ts";
import { getDocument } from "#db/space/documents.ts";

/**
 * List the space's audit log
 *
 * @tag Spaces
 * @paginated
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = new URL(context.req.url).searchParams.get("documentId");

    // Ahead of opening the store, which a space that does not exist would
    // answer with a read error rather than a verdict.
    await requireSpace(spaceId);

    const store = await openSpaceStore(spaceId);
    const document = documentId ? await getDocument(store, documentId) : null;

    // An audit trail outlives the document it describes, so a deleted one is
    // gated on the space role — which is what its own grants resolved to.
    if (documentId && document) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        user.id,
        Permission.VIEWER,
      );
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.VIEWER,
      );
    }

    // Verify user has audit log viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_AUDIT, user.id);

    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
    );

    const { rows, nextCursor } = documentId
      ? await getAuditLogsForDocument(store, documentId, limit, cursor)
      : await getRecentAuditLogs(store, limit, cursor);

    const auditLogs = rows.map((log) => ({
      ...log,
      details: parseAuditDetails(log),
    }));

    return jsonResponse({ auditLogs, limit, nextCursor });
  }, "Failed to list space audit logs");

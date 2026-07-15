import { sql } from "drizzle-orm";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  denyFeature,
  Feature,
  grantFeature,
  grantPermission,
  listFeaturePermissions,
  listPermissions,
  ResourceType,
  revokeFeature,
  revokePermission,
} from "#db/acl.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuthDb } from "#db/db.ts";
import { user as userTable } from "#db/schema/auth.ts";

// GET /api/v1/spaces/:spaceId/permissions
// List all permissions (roles and feature overrides)
// Query params: ?type=role|feature|all (default: all)
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    const typeFilter = new URL(context.req.url).searchParams.get("type") || "all";
    const resourceType =
      (new URL(context.req.url).searchParams.get("resourceType") as ResourceType) ||
      ResourceType.SPACE;
    const resourceId = new URL(context.req.url).searchParams.get("resourceId") || spaceId;

    await verifySpaceRole(spaceId, user.id, "editor");

    const permissions: Array<{ type: string; permission: unknown }> = [];

    // Get role permissions (space members)
    if (typeFilter === "all" || typeFilter === "role") {
      const rolePermissions = await listPermissions(spaceId, resourceType, resourceId);
      permissions.push(
        ...rolePermissions.map((p) => ({
          type: "role" as const,
          permission: p,
        })),
      );
    }

    // Get feature permissions
    if (typeFilter === "all" || typeFilter === "feature") {
      const featurePermissions = await listFeaturePermissions(spaceId);
      permissions.push(
        ...featurePermissions.map((p) => ({
          type: "feature" as const,
          permission: p,
        })),
      );
    }

    return jsonResponse({ permissions });
  }, "Failed to list permissions");

// POST /api/v1/spaces/:spaceId/permissions
// Grant, deny, or revoke permissions (roles or features)
// Body: {
//   type: "role" | "feature",
//   roleOrFeature: "viewer" | "editor" | "owner" | "comment" | "view_history" | ...,
//   userId?: string,
//   groupId?: string,
//   action: "grant" | "deny" | "revoke"
// }
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    const body = (await parseJsonBody(context.req.raw)) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type : undefined;
    const roleOrFeature =
      typeof body.roleOrFeature === "string" ? body.roleOrFeature : undefined;
    let userId = typeof body.userId === "string" ? body.userId : undefined;
    const email =
      typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined;
    const groupId = typeof body.groupId === "string" ? body.groupId : undefined;
    const action = typeof body.action === "string" ? body.action : undefined;
    const resourceType =
      typeof body.resourceType === "string" ? body.resourceType : undefined;
    const resourceId = typeof body.resourceId === "string" ? body.resourceId : undefined;

    const targetResourceType = (resourceType as ResourceType) || ResourceType.SPACE;

    // Auth rules for role grants/revokes:
    //   - Granting owner requires owner.
    //   - Revoking any space-level role requires owner.
    //   - Editors can grant viewer/editor at space, document, or document-tree level.
    //   - Editors can revoke document-level and document-tree permissions.
    // Feature operations always require owner.
    if (type === "role") {
      if (action === "grant" && roleOrFeature === "owner") {
        await verifySpaceRole(spaceId, user.id, "owner");
      } else if (
        action === "revoke" &&
        targetResourceType !== ResourceType.DOCUMENT &&
        targetResourceType !== ResourceType.DOCUMENT_TREE
      ) {
        await verifySpaceRole(spaceId, user.id, "owner");
      } else {
        await verifySpaceRole(spaceId, user.id, "editor");
      }
    } else {
      await verifySpaceRole(spaceId, user.id, "owner");
    }

    if (!type || !["role", "feature"].includes(type)) {
      throw badRequestResponse("type must be 'role' or 'feature'");
    }

    if (!roleOrFeature || typeof roleOrFeature !== "string") {
      throw badRequestResponse(
        type === "role"
          ? "roleOrFeature must be one of: viewer, editor, owner"
          : `roleOrFeature must be one of: ${Object.values(Feature).join(", ")}`,
      );
    }

    // Resolve an email address to a user id so owners can invite people by
    // email without knowing their internal id. Exact, case-insensitive match;
    // returns 404 when no account exists for that email. Gated behind the
    // space-role authorization already enforced above.
    if (!userId && !groupId && email) {
      const authDb = getAuthDb();
      const match = await authDb
        .select({ id: userTable.id })
        .from(userTable)
        .where(sql`lower(${userTable.email}) = ${email.toLowerCase()}`)
        .get();
      if (!match) {
        throw notFoundResponse(`No user found with email "${email}"`);
      }
      userId = match.id;
    }

    if (!userId && !groupId) {
      throw badRequestResponse("Either userId, email, or groupId is required");
    }

    if (!action || !["grant", "deny", "revoke"].includes(action)) {
      throw badRequestResponse("action must be one of: grant, deny, revoke");
    }

    // Validate role/feature
    if (type === "role") {
      if (!["viewer", "editor", "owner"].includes(roleOrFeature)) {
        throw badRequestResponse("roleOrFeature must be one of: viewer, editor, owner");
      }

      const targetResourceId = resourceId || spaceId;

      if (action === "grant" || action === "deny") {
        const entry = await grantPermission(
          spaceId,
          targetResourceType,
          targetResourceId,
          userId,
          roleOrFeature,
          groupId,
        );
        return jsonResponse({ permission: entry });
      }

      // action === "revoke"
      await revokePermission(
        spaceId,
        targetResourceType,
        targetResourceId,
        userId,
        groupId,
      );
      return jsonResponse({ success: true });
    }

    // type === "feature"
    if (!Object.values(Feature).includes(roleOrFeature as Feature)) {
      throw badRequestResponse(
        `roleOrFeature must be one of: ${Object.values(Feature).join(", ")}`,
      );
    }

    const feature = roleOrFeature as Feature;

    if (action === "grant") {
      const entry = await grantFeature(spaceId, feature, userId, groupId);
      return jsonResponse({ permission: entry });
    }

    if (action === "deny") {
      const entry = await denyFeature(spaceId, feature, userId, groupId);
      return jsonResponse({ permission: entry });
    }

    // action === "revoke"
    await revokeFeature(spaceId, feature, userId, groupId);
    return jsonResponse({ success: true });
  }, "Failed to update permissions");

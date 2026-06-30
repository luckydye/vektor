import type { APIRoute } from "astro";
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
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";

// GET /api/v1/spaces/:spaceId/permissions
// List all permissions (roles and feature overrides)
// Query params: ?type=role|feature|all (default: all)
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    const typeFilter = context.url.searchParams.get("type") || "all";
    const resourceType =
      (context.url.searchParams.get("resourceType") as ResourceType) ||
      ResourceType.SPACE;
    const resourceId = context.url.searchParams.get("resourceId") || spaceId;

    // Editors can list role permissions at any resource level.
    // Feature permission listing is owner-only.
    const requiredRole = typeFilter === "feature" ? "owner" : "editor";
    await verifySpaceRole(spaceId, user.id, requiredRole);

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
export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    const body = (await parseJsonBody(context.request)) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type : undefined;
    const roleOrFeature =
      typeof body.roleOrFeature === "string" ? body.roleOrFeature : undefined;
    const userId = typeof body.userId === "string" ? body.userId : undefined;
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

    if (!userId && !groupId) {
      throw badRequestResponse("Either userId or groupId is required");
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

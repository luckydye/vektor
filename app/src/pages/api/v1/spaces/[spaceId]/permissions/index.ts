import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  Feature,
  grantPermission,
  grantFeature,
  denyFeature,
  revokePermission,
  revokeFeature,
  listPermissions,
  listFeaturePermissions,
  ResourceType,
} from "#db/acl.ts";

// GET /api/v1/spaces/:spaceId/permissions
// List all permissions (roles and feature overrides)
// Query params: ?type=role|feature|all (default: all)
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "owner");

    const typeFilter = context.url.searchParams.get("type") || "all";
    const resourceType =
      (context.url.searchParams.get("resourceType") as ResourceType) ||
      ResourceType.SPACE;
    const resourceId = context.url.searchParams.get("resourceId") || spaceId;

    const permissions: Array<{ type: string; permission: any }> = [];

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

    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody(context.request);
    const { type, roleOrFeature, userId, groupId, action, resourceType, resourceId } =
      body;

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

      const targetResourceType = (resourceType as ResourceType) || ResourceType.SPACE;
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

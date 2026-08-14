import { sql } from "drizzle-orm";
import { verifySpaceRole } from "#acl/guards.ts";
import {
  allFeatures,
  allPermissions,
  highestPermission,
  isFeature,
  isPermission,
  isResourceType,
  meetsPermissionLevel,
  Permission,
  permissionLevel,
  ResourceType,
} from "#acl/permissions.ts";
import {
  denyFeature,
  grantFeature,
  grantPermission,
  listAllRolePermissions,
  listFeaturePermissions,
  listPermissions,
  revokeFeature,
  revokePermission,
} from "#acl/store.ts";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { user as userTable } from "#db/schema/auth.ts";

// GET /api/v1/spaces/:spaceId/permissions
// List all permissions (roles and feature overrides)
// Query params: ?type=role|feature|all (default: all)
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    const searchParams = new URL(context.req.url).searchParams;
    const typeFilter = searchParams.get("type") || "all";
    const resourceType =
      (searchParams.get("resourceType") as ResourceType) || ResourceType.SPACE;
    const resourceId = searchParams.get("resourceId") || spaceId;
    const allResources = searchParams.get("allResources") === "true";
    const store = await openSpaceStore(spaceId);

    await verifySpaceRole(
      spaceId,
      user.id,
      allResources ? Permission.OWNER : Permission.EDITOR,
    );

    const permissions: Array<{ type: string; permission: unknown }> = [];

    // Get role permissions (space members)
    if (typeFilter === "all" || typeFilter === "role") {
      const rolePermissions = allResources
        ? await listAllRolePermissions(store)
        : await listPermissions(store, resourceType, resourceId);
      permissions.push(
        ...rolePermissions.map((p) => ({
          type: "role" as const,
          permission: p,
        })),
      );
    }

    // Get feature permissions
    if (typeFilter === "all" || typeFilter === "feature") {
      const featurePermissions = await listFeaturePermissions(store);
      permissions.push(
        ...featurePermissions.map((p) => ({
          type: "feature" as const,
          permission: p,
        })),
      );
    }

    return jsonResponse({ permissions });
  }, "Failed to list permissions");

const ROLE_ACTIONS: readonly string[] = ["grant", "revoke"];
const FEATURE_ACTIONS: readonly string[] = ["grant", "deny", "revoke"];

const EDITOR_DELEGABLE_SCOPES: readonly ResourceType[] = [
  ResourceType.SPACE,
  ResourceType.DOCUMENT,
  ResourceType.DOCUMENT_TREE,
  ResourceType.CATEGORY,
];

const EDITOR_WITHDRAWABLE_SCOPES: readonly ResourceType[] = [
  ResourceType.DOCUMENT,
  ResourceType.DOCUMENT_TREE,
];

async function currentRoleOnResource(
  resourceType: ResourceType,
  resourceId: string,
  grantee: { userId?: string; groupId?: string },
  store: SpaceStore,
): Promise<Permission | undefined> {
  const entries = await listPermissions(store, resourceType, resourceId);
  return highestPermission(
    entries
      .filter(
        (entry) =>
          (grantee.userId && entry.userId === grantee.userId && !entry.groupId) ||
          (grantee.groupId && entry.groupId === grantee.groupId && !entry.userId),
      )
      .map((entry) => entry.permission),
  );
}

async function requiredRoleForRoleWrite(
  resourceType: ResourceType,
  resourceId: string,
  grantee: { userId?: string; groupId?: string },
  role: Permission | undefined,
  store: SpaceStore,
): Promise<Permission> {
  if (meetsPermissionLevel(role, Permission.OWNER)) {
    return Permission.OWNER;
  }

  if (!EDITOR_DELEGABLE_SCOPES.includes(resourceType)) {
    return Permission.OWNER;
  }

  const displaced = await currentRoleOnResource(resourceType, resourceId, grantee, store);

  if (meetsPermissionLevel(displaced, Permission.OWNER)) {
    return Permission.OWNER;
  }

  const withdraws =
    !role ||
    (displaced !== undefined && permissionLevel(role) < permissionLevel(displaced));
  if (withdraws && !EDITOR_WITHDRAWABLE_SCOPES.includes(resourceType)) {
    return Permission.OWNER;
  }

  return Permission.EDITOR;
}

async function isSpaceOwner(spaceId: string, userId: string): Promise<boolean> {
  try {
    await verifySpaceRole(spaceId, userId, Permission.OWNER);
    return true;
  } catch (error) {
    if (error instanceof Response && error.status === 403) return false;
    throw error;
  }
}

// POST /api/v1/spaces/:spaceId/permissions
// Grant or revoke a role, or grant/deny/revoke a feature
// Body: {
//   type: "role" | "feature",
//   roleOrFeature: "viewer" | "editor" | "owner" | "comment" | "view_history" | ...,
//   userId?: string,
//   email?: string,
//   groupId?: string,
//   resourceType?: "space" | "document" | "document_tree" | "category" | ...,
//   resourceId?: string,
//   action: "grant" | "revoke" for roles, "grant" | "deny" | "revoke" for features
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

    if (type !== "role" && type !== "feature") {
      throw badRequestResponse("type must be 'role' or 'feature'");
    }

    const allowedActions = type === "role" ? ROLE_ACTIONS : FEATURE_ACTIONS;
    if (!action || !allowedActions.includes(action)) {
      throw badRequestResponse(`action must be one of: ${allowedActions.join(", ")}`);
    }

    if (resourceType !== undefined && !isResourceType(resourceType)) {
      throw badRequestResponse(
        `resourceType must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    const targetResourceType = resourceType ?? ResourceType.SPACE;

    await verifySpaceRole(
      spaceId,
      user.id,
      type === "role" ? Permission.EDITOR : Permission.OWNER,
    );
    const callerIsOwner = type === "role" && (await isSpaceOwner(spaceId, user.id));

    // Resolve an email address to a user id so owners can invite people by
    // email without knowing their internal id. Exact, case-insensitive match;
    // returns 404 when no account exists for that email. Gated behind the
    // space-role authorization already enforced above.
    if (!userId && !groupId && email) {
      const authDb = getAuthDb();
      const match = await one(
        authDb
          .select({ id: userTable.id })
          .from(userTable)
          .where(sql`lower(${userTable.email}) = ${email.toLowerCase()}`),
      );
      if (!match) {
        throw errorResponse(`No user found with email "${email}"`, 404);
      }
      userId = match.id;
    }

    if (!userId && !groupId) {
      throw badRequestResponse("Either userId, email, or groupId is required");
    }

    if (type === "role") {
      if (!isPermission(roleOrFeature)) {
        throw badRequestResponse(
          `roleOrFeature must be one of: ${allPermissions().join(", ")}`,
        );
      }

      const targetResourceId = resourceId || spaceId;
      const grantee = { userId, groupId };

      const resultingRole = action === "grant" ? roleOrFeature : undefined;

      const store = await openSpaceStore(spaceId);
      return store.tx(async (transaction) => {
        const requiredRole = await requiredRoleForRoleWrite(
          targetResourceType,
          targetResourceId,
          grantee,
          resultingRole,
          transaction,
        );
        if (requiredRole === Permission.OWNER && !callerIsOwner) {
          throw forbiddenResponse();
        }

        if (resultingRole) {
          const entry = await grantPermission(
            transaction,
            targetResourceType,
            targetResourceId,
            userId,
            resultingRole,
            groupId,
            user.id,
          );
          return jsonResponse({ permission: entry });
        }

        await revokePermission(
          transaction,
          targetResourceType,
          targetResourceId,
          userId,
          groupId,
          user.id,
        );
        return jsonResponse({ success: true });
      });
    }

    // type === "feature"; owner already verified above
    if (!isFeature(roleOrFeature)) {
      throw badRequestResponse(
        `roleOrFeature must be one of: ${allFeatures().join(", ")}`,
      );
    }

    if (action === "grant") {
      const entry = await grantFeature(spaceId, roleOrFeature, userId, groupId, user.id);
      return jsonResponse({ permission: entry });
    }

    if (action === "deny") {
      const entry = await denyFeature(spaceId, roleOrFeature, userId, groupId, user.id);
      return jsonResponse({ permission: entry });
    }

    // action === "revoke"
    await revokeFeature(spaceId, roleOrFeature, userId, groupId, user.id);
    return jsonResponse({ success: true });
  }, "Failed to update permissions");

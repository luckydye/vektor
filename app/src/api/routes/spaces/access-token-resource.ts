import { validateTokenGrant, verifySpaceRole } from "#acl/guards.ts";
import { isResourceType, Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  grantTokenAccess,
  listTokenResources,
  revokeAccessToken,
} from "#db/space/accessTokens.ts";

/**
 * PUT /api/v1/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId
 * Re-scope a token, or change what it grants. A token holds one grant, so this
 * replaces it rather than adding to it.
 * Body:
 *   - permission: "viewer" | "editor"
 */
export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");
    const resourceType = requireParam(context.var.params, "resourceType");
    const resourceId = requireParam(context.var.params, "resourceId");

    // Granting token access is a privileged delegation; restrict to owners.
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    if (!isResourceType(resourceType)) {
      throw badRequestResponse(
        `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    const body = await parseJsonBody(context.req.raw);
    const { permission } = body;

    if (!permission || typeof permission !== "string") {
      throw badRequestResponse("Permission is required");
    }

    const store = await openSpaceStore(spaceId);
    const granted = await grantTokenAccess(
      store,
      tokenId,
      resourceType,
      resourceId,
      validateTokenGrant(resourceType, permission),
    );
    if (!granted) {
      throw notFoundResponse("Access token");
    }

    const resources = await listTokenResources(store, tokenId);

    return jsonResponse({ resources, message: "Access granted successfully" });
  }, "Failed to grant access token resource");

/**
 * DELETE /api/v1/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId
 * Revoke the token's grant. The grant is the token, so this revokes the
 * credential with it — the secret stops authenticating rather than surviving
 * with nothing behind it.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");
    const resourceType = requireParam(context.var.params, "resourceType");

    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    if (!isResourceType(resourceType)) {
      throw badRequestResponse(
        `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    await revokeAccessToken(await openSpaceStore(spaceId), tokenId);

    return successResponse({ message: "Resource access revoked successfully" });
  }, "Failed to revoke access token resource");

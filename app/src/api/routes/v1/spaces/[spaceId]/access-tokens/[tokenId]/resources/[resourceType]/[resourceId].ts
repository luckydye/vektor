import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  grantTokenAccess,
  listTokenResources,
  revokeTokenAccess,
} from "#db/accessTokens.ts";
import { ResourceType, type ResourceType as ResourceTypeValue } from "#db/acl.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifyCanGrantTokenAccess,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";

/**
 * PUT /api/v1/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId
 * Grant token access to a resource in this space.
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
    await verifySpaceRole(spaceId, user.id, "owner");

    if (!Object.values(ResourceType).includes(resourceType as ResourceTypeValue)) {
      throw badRequestResponse(
        `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    const body = await parseJsonBody(context.req.raw);
    const { permission } = body;

    if (!permission || typeof permission !== "string") {
      throw badRequestResponse("Permission is required");
    }

    // Validate the grant and ensure the caller cannot delegate more than they hold.
    await verifyCanGrantTokenAccess(
      spaceId,
      user.id,
      resourceType as ResourceTypeValue,
      resourceId,
      permission,
    );

    await grantTokenAccess({
      tokenId,
      spaceId,
      resourceType: resourceType as ResourceTypeValue,
      resourceId,
      permission,
    });

    const resources = await listTokenResources(tokenId, spaceId);

    return jsonResponse({ resources, message: "Access granted successfully" });
  }, "Failed to grant access token resource");

/**
 * DELETE /api/v1/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId
 * Revoke token access to a specific resource in this space.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");
    const resourceType = requireParam(context.var.params, "resourceType");
    const resourceId = requireParam(context.var.params, "resourceId");

    await verifySpaceRole(spaceId, user.id, "owner");

    if (!Object.values(ResourceType).includes(resourceType as ResourceTypeValue)) {
      throw badRequestResponse(
        `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    await revokeTokenAccess(
      tokenId,
      spaceId,
      resourceType as ResourceTypeValue,
      resourceId,
    );

    return successResponse({ message: "Resource access revoked successfully" });
  }, "Failed to revoke access token resource");

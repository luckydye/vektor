import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  grantTokenAccess,
  listTokenResources,
  revokeTokenAccess,
} from "#db/accessTokens.ts";
import { ResourceType, type ResourceType as ResourceTypeValue } from "#db/acl.ts";

/**
 * PUT /api/v1/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId
 * Grant token access to a resource in this space.
 * Body:
 *   - permission: "viewer" | "editor"
 */
export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const tokenId = requireParam(context.params, "tokenId");
    const resourceType = requireParam(context.params, "resourceType");
    const resourceId = requireParam(context.params, "resourceId");

    await verifySpaceRole(spaceId, user.id, "editor");

    if (!Object.values(ResourceType).includes(resourceType as ResourceTypeValue)) {
      throw badRequestResponse(
        `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
      );
    }

    const body = await parseJsonBody(context.request);
    const { permission } = body;

    if (!permission || typeof permission !== "string") {
      throw badRequestResponse("Permission is required");
    }

    const validPermissions = ["viewer", "editor"];
    if (!validPermissions.includes(permission)) {
      throw badRequestResponse(
        `Permission must be one of: ${validPermissions.join(", ")}`,
      );
    }

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
export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const tokenId = requireParam(context.params, "tokenId");
    const resourceType = requireParam(context.params, "resourceType");
    const resourceId = requireParam(context.params, "resourceId");

    await verifySpaceRole(spaceId, user.id, "editor");

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

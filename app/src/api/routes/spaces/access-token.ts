import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  deleteAccessToken,
  getAccessToken,
  listTokenResources,
  revokeAccessToken,
} from "#db/space/accessTokens.ts";

/**
 * GET /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Get token details and its resources in this space
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );

    const token = await getAccessToken(await openSpaceStore(spaceId), tokenId);
    if (!token) {
      throw notFoundResponse("Access token");
    }

    const resources = await listTokenResources(await openSpaceStore(spaceId), tokenId);

    return jsonResponse({ token: { ...token, resources } });
  }, "Failed to get access token");

/**
 * PATCH /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Revoke an access token (soft delete)
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

    const success = await revokeAccessToken(
      await openSpaceStore(spaceId),
      tokenId,
      user.id,
    );
    if (!success) {
      throw notFoundResponse("Access token");
    }

    return successResponse({ message: "Token revoked successfully" });
  }, "Failed to revoke access token");

/**
 * DELETE /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Permanently delete an access token
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const tokenId = requireParam(context.var.params, "tokenId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

    const success = await deleteAccessToken(
      await openSpaceStore(spaceId),
      tokenId,
      user.id,
    );
    if (!success) {
      throw notFoundResponse("Access token");
    }

    return successResponse({ message: "Token deleted successfully" });
  }, "Failed to delete access token");

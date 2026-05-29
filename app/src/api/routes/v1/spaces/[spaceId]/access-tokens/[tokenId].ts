import type { APIRoute } from "astro";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  revokeAccessToken,
  deleteAccessToken,
  listTokenResources,
  getAccessToken,
} from "#db/accessTokens.ts";

/**
 * GET /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Get token details and its resources in this space
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const tokenId = requireParam(context.params, "tokenId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const token = await getAccessToken(spaceId, tokenId);
    if (!token) {
      throw notFoundResponse("Access token");
    }

    const resources = await listTokenResources(tokenId, spaceId);

    return jsonResponse({ token: { ...token, resources } });
  }, "Failed to get access token");

/**
 * PATCH /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Revoke an access token (soft delete)
 */
export const PATCH: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const tokenId = requireParam(context.params, "tokenId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const success = await revokeAccessToken(spaceId, tokenId);
    if (!success) {
      throw notFoundResponse("Access token");
    }

    return successResponse({ message: "Token revoked successfully" });
  }, "Failed to revoke access token");

/**
 * DELETE /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * Permanently delete an access token
 */
export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const tokenId = requireParam(context.params, "tokenId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const success = await deleteAccessToken(spaceId, tokenId);
    if (!success) {
      throw notFoundResponse("Access token");
    }

    return successResponse({ message: "Token deleted successfully" });
  }, "Failed to delete access token");

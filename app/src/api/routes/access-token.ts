/**
 * One of the caller's own personal access tokens. Which space holds it is
 * resolved from the caller's own tokens, so a token id belonging to anyone else
 * reads as not found rather than as a token this caller may touch.
 */

import {
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
  findPersonalTokenSpace,
  revokeAccessToken,
} from "#db/space/accessTokens.ts";

/**
 * PATCH /api/v1/access-tokens/:tokenId
 * Revoke one of the caller's tokens (soft delete).
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const tokenId = requireParam(context.var.params, "tokenId");

    const spaceId = await findPersonalTokenSpace(user.id, tokenId);
    if (!spaceId) {
      throw notFoundResponse("Access token");
    }

    await revokeAccessToken(await openSpaceStore(spaceId), tokenId, user.id);

    return successResponse({ message: "Token revoked successfully" });
  }, "Failed to revoke access token");

/**
 * DELETE /api/v1/access-tokens/:tokenId
 * Permanently delete one of the caller's tokens, and the grant it carries.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const tokenId = requireParam(context.var.params, "tokenId");

    const spaceId = await findPersonalTokenSpace(user.id, tokenId);
    if (!spaceId) {
      throw notFoundResponse("Access token");
    }

    await deleteAccessToken(await openSpaceStore(spaceId), tokenId, user.id);

    return successResponse({ message: "Token deleted successfully" });
  }, "Failed to delete access token");

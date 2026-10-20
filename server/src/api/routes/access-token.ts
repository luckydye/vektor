import {
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openPersonalTokenStore } from "#api/tokenSpace.ts";
import { deleteAccessToken, revokeAccessToken } from "#db/space/accessTokens.ts";

/**
 * Update one of the caller's access tokens
 *
 * One of the caller's own personal access tokens, in the space named by
 * `?space=`. A token id belonging to anyone else reads as not found rather than
 * as a token this caller may touch. This revokes it (soft delete).
 *
 * @tag Access tokens
 * @query space! ID of the space holding the token.
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const tokenId = requireParam(context.var.params, "tokenId");

    const store = await openPersonalTokenStore(context, user.id, tokenId);
    await revokeAccessToken(store, tokenId, user.id);

    return successResponse({ message: "Token revoked successfully" });
  }, "Failed to revoke access token");

/**
 * Revoke one of the caller's access tokens
 *
 * Permanently deletes it, and the grant it carries.
 *
 * @tag Access tokens
 * @query space! ID of the space holding the token.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const tokenId = requireParam(context.var.params, "tokenId");

    const store = await openPersonalTokenStore(context, user.id, tokenId);
    await deleteAccessToken(store, tokenId, user.id);

    return successResponse({ message: "Token deleted successfully" });
  }, "Failed to delete access token");

import { isPermission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createAccessToken,
  listPersonalAccessTokens,
  listTokenResources,
  MAX_ACCESS_TOKEN_EXPIRY_DAYS,
} from "#db/space/accessTokens.ts";
import { getSpace, getUserSpaceRole } from "#db/space/spaces.ts";
import { addPositiveDays, isValidPositiveDayDuration } from "#utils/datetime.ts";

/**
 * List the caller's personal access tokens
 *
 * The ones the caller issued for itself, the same kind `vektor login` mints,
 * across the spaces it belongs to.
 *
 * @tag Access tokens
 * @note The caller's own tokens, across the spaces they belong to.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    return jsonResponse({ tokens: await listPersonalAccessTokens(user.id) });
  }, "Failed to list access tokens");

/**
 * Issue a personal access token
 *
 * Mints a token carrying the caller's own role on one space — it can never
 * open more than its issuer already holds, which is why this needs no owner
 * check, unlike the space-wide endpoint that mints tokens on other people's
 * behalf. The token secret is returned once, in this response only.
 *
 * @tag Access tokens
 * @status 201
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const body = await parseJsonBody(context.req.raw);
    const { name, spaceId, expiresInDays } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw badRequestResponse("Token name is required");
    }

    if (!spaceId || typeof spaceId !== "string") {
      throw badRequestResponse("Space ID is required");
    }

    const space = await getSpace(spaceId);
    if (!space) {
      throw notFoundResponse("Space");
    }

    // A resource-scoped grantee holds no space-wide role, so there is nothing to
    // delegate — the token would authenticate and then open nothing.
    const permission = await getUserSpaceRole(space, user.id);
    if (!isPermission(permission)) {
      throw forbiddenResponse("You do not hold a role on this space");
    }

    let expiresAt: Date | undefined;
    if (expiresInDays !== undefined && expiresInDays !== null) {
      if (!isValidPositiveDayDuration(expiresInDays, MAX_ACCESS_TOKEN_EXPIRY_DAYS)) {
        throw badRequestResponse(
          `expiresInDays must be greater than 0 and at most ${MAX_ACCESS_TOKEN_EXPIRY_DAYS}`,
        );
      }
      expiresAt = addPositiveDays(new Date(), expiresInDays);
    }

    const store = await openSpaceStore(spaceId);
    const result = await createAccessToken(store, {
      name: name.trim(),
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      permission,
      expiresAt,
      createdBy: user.id,
    });

    return createdResponse({
      id: result.id,
      token: result.token,
      spaceId,
      permission,
      resources: await listTokenResources(store, result.id),
      message:
        "Token created successfully. Make sure to save it - you won't be able to see it again!",
    });
  }, "Failed to create access token");

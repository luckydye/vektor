import { validateTokenGrant, verifyAccess } from "#acl/guards.ts";
import { Feature, isResourceType, Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createAccessToken,
  listAccessTokens,
  listTokenResources,
  MAX_ACCESS_TOKEN_EXPIRY_DAYS,
} from "#db/space/accessTokens.ts";
import { addPositiveDays, isValidPositiveDayDuration } from "#utils/datetime.ts";

/**
 * List the space's access tokens (never the secrets)
 *
 * GET /api/v1/spaces/:spaceId/access-tokens
 * List all access tokens and their permissions in this space
 *
 * @tag Access tokens
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );

    // Get all tokens for this space
    const tokens = await listAccessTokens(await openSpaceStore(spaceId));

    // For each token, get its resources
    const tokensWithResources = await Promise.all(
      tokens.map(async (token) => {
        const resources = await listTokenResources(
          await openSpaceStore(spaceId),
          token.id,
        );
        return {
          ...token,
          resources,
        };
      }),
    );

    return jsonResponse({ tokens: tokensWithResources });
  }, "Failed to list access tokens");

/**
 * Issue a space access token
 *
 * The token secret is returned once, in this response only.
 *
 * POST /api/v1/spaces/:spaceId/access-tokens
 * Create a new access token and assign it to a resource
 * Body:
 *   - name: Token name/description
 *   - resourceType: "space" | "document" | "category"
 *   - resourceId: ID of the resource (use spaceId for space-level access)
 *   - permission: "viewer" | "editor" | "owner"
 *   - expiresInDays: Optional expiration in days
 *
 * @tag Access tokens
 * @body
 * @status 201
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    // Token creation is a privileged delegation; restrict to space owners.
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

    const body = await parseJsonBody(context.req.raw);
    const { name, resourceType, resourceId, permission, expiresInDays } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw badRequestResponse("Token name is required");
    }

    if (!permission || typeof permission !== "string") {
      throw badRequestResponse("Permission is required");
    }

    // "extensions" is a space-wide capability, not a resource grant: it has no
    // resource id and lets the token install/update any extension (including
    // new ones). The caller is already verified as a space owner above, which
    // is the level that holds `manage_extensions` by default — so delegating it
    // to a token does not escalate beyond what the caller has.
    const isExtensionsCapability = permission === "extensions";

    // The capability is stored as the feature grant it is, so the token is one
    // row like any other.
    let grant: { resourceType: ResourceType; resourceId: string; permission: string };

    if (isExtensionsCapability) {
      grant = {
        resourceType: ResourceType.FEATURE,
        resourceId: Feature.MANAGE_EXTENSIONS,
        permission: Permission.VIEWER,
      };
    } else {
      if (!resourceType || !isResourceType(resourceType)) {
        throw badRequestResponse(
          `Resource type must be one of: ${Object.values(ResourceType).join(", ")}`,
        );
      }

      if (!resourceId || typeof resourceId !== "string") {
        throw badRequestResponse("Resource ID is required");
      }

      grant = {
        resourceType,
        resourceId,
        permission: validateTokenGrant(resourceType, permission),
      };
    }

    let expiresAt: Date | undefined;
    if (expiresInDays !== undefined) {
      if (!isValidPositiveDayDuration(expiresInDays, MAX_ACCESS_TOKEN_EXPIRY_DAYS)) {
        throw badRequestResponse(
          `expiresInDays must be greater than 0 and at most ${MAX_ACCESS_TOKEN_EXPIRY_DAYS}`,
        );
      }
      expiresAt = addPositiveDays(new Date(), expiresInDays);
    }

    const store = await openSpaceStore(spaceId);
    const result = await createAccessToken(store, {
      ...grant,
      name: name.trim(),
      expiresAt,
      createdBy: user.id,
    });

    const resources = await listTokenResources(store, result.id);

    return createdResponse({
      id: result.id,
      token: result.token,
      resources,
      message:
        "Token created successfully. Make sure to save it - you won't be able to see it again!",
    });
  }, "Failed to create access token");

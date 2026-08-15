import { validateTokenGrant, verifySpaceRole } from "#acl/guards.ts";
import { isResourceType, Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { grantTokenAccess, listTokenResources } from "#db/space/accessTokens.ts";

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
      user.id,
    );
    if (!granted) {
      throw notFoundResponse("Access token");
    }

    const resources = await listTokenResources(store, tokenId);

    return jsonResponse({ resources, message: "Access granted successfully" });
  }, "Failed to grant access token resource");

/*
 * There is deliberately no DELETE here. A token holds exactly one grant, so
 * removing the grant named in the path could only ever mean revoking the
 * credential — which PATCH /api/v1/spaces/:spaceId/access-tokens/:tokenId
 * already does, without a resource in the url implying a granularity that does
 * not exist.
 */

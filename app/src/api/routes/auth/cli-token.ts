/**
 * POST /api/v1/auth/cli/token
 *
 * Exchanges the one-time code produced by POST /api/v1/auth/cli for a real
 * access token. No session cookie required — the code itself is the proof of
 * authentication. Single-use; expires 60 seconds after issuance.
 *
 * The token delegates the approving user's own access: it carries the role that
 * user holds on the space, resolved here rather than at approval so a role
 * revoked in between is honoured.
 *
 * Body:  { code: string }
 * Returns: { token: string, spaceId: string, permission: string, expiresAt: string }
 */

import { isPermission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  parseJsonBody,
  withApiErrorHandling,
} from "#api/http.ts";
import { pendingCliCodes } from "#api/routes/auth/cli.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createAccessToken } from "#db/space/accessTokens.ts";
import { getSpace, getUserSpaceRole } from "#db/space/spaces.ts";

/** Bounded so a role revoked later cannot leave standing access forever. */
const CLI_TOKEN_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const body = await parseJsonBody(context.req.raw);
    const { code } = body;

    if (!code || typeof code !== "string") {
      throw badRequestResponse("code is required");
    }

    const entry = pendingCliCodes.get(code);
    if (!entry) {
      throw badRequestResponse("Invalid or expired code");
    }
    if (Date.now() > entry.expiresAt) {
      pendingCliCodes.delete(code);
      throw badRequestResponse("Code has expired");
    }

    // Single-use — delete immediately.
    pendingCliCodes.delete(code);

    const { userId, spaceId } = entry;

    const space = await getSpace(spaceId);
    if (!space) {
      throw badRequestResponse("Selected space is no longer available");
    }

    // A resource-scoped grantee holds no space-wide role, so they get nothing —
    // the approval step refuses those spaces already, this is the second line.
    const permission = await getUserSpaceRole(space, userId);
    if (!isPermission(permission)) {
      throw forbiddenResponse("You do not hold a role on this space");
    }

    const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_DAYS * DAY_MS);

    const result = await createAccessToken(await openSpaceStore(spaceId), {
      name: `CLI (${new Date().toISOString().slice(0, 10)})`,
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      permission,
      createdBy: userId,
      expiresAt,
    });

    return Response.json({
      token: result.token,
      spaceId,
      permission,
      expiresAt: expiresAt.toISOString(),
    });
  }, "Token exchange failed");

/**
 * POST /api/v1/auth/cli/token
 *
 * Exchanges the one-time code produced by POST /api/v1/auth/cli for a real
 * access token. No session cookie required — the code itself is the proof of
 * authentication. Single-use; expires 60 seconds after issuance.
 *
 * The token is a delegation of the approving user's own access: it carries the
 * role that user actually holds on the space (resolved here, at exchange time,
 * so a role revoked after approval is honoured) and never more, enforced by the
 * same `verifyCanGrantTokenAccess` rule the access-token endpoint applies.
 *
 * Body:  { code: string }
 * Returns: { token: string, spaceId: string, permission: string, expiresAt: string }
 */

import { verifyCanGrantTokenAccess } from "#acl/guards.ts";
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
import { createAccessToken, grantTokenAccess } from "#db/space/accessTokens.ts";
import { getSpace, getUserSpaceRole } from "#db/space/spaces.ts";

/**
 * How long a CLI token stays valid. A CLI login is an interactive act, so the
 * credential it mints must not outlive the user's attention to it — an
 * unbounded token turns a revoked role into standing access.
 */
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

    // The user's real space-wide role — never a fixed level. A viewer gets a
    // viewer token; someone who reached the space only through a document,
    // document-tree or category grant holds no space-wide role at all and gets
    // nothing (the approval step already refuses those spaces; this is the
    // second line of defence).
    const permission = await getUserSpaceRole(space, userId);
    if (!isPermission(permission)) {
      throw forbiddenResponse("You do not hold a role on this space");
    }

    // The same rule the access-token endpoint enforces: a token may never carry
    // more authority than the user delegating it.
    await verifyCanGrantTokenAccess(
      spaceId,
      userId,
      ResourceType.SPACE,
      spaceId,
      permission,
    );

    const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_DAYS * DAY_MS);

    const result = await createAccessToken(await openSpaceStore(spaceId), {
      spaceId,
      name: `CLI (${new Date().toISOString().slice(0, 10)})`,
      createdBy: userId,
      expiresAt,
    });

    await grantTokenAccess({
      tokenId: result.id,
      spaceId,
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      permission,
    });

    return Response.json({
      token: result.token,
      spaceId,
      permission,
      expiresAt: expiresAt.toISOString(),
    });
  }, "Token exchange failed");

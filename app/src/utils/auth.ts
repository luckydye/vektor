import type { APIContext } from "astro";
import {
  forbiddenResponse,
  requireUser,
  verifySpaceRole,
  verifyDocumentRole,
  authenticateWithToken,
  verifyTokenPermission,
} from "#db/api.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import { ResourceType } from "#db/acl.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

/**
 * Verify `userId` actually holds `requiredRole` on `target`, using the same
 * resolution as an interactive session would: document targets fall back to
 * the space role (see `hasPermission`), everything else is gated on the space
 * role directly. Throws a 403/404 Response on failure.
 */
async function enforceUserRoleOnTarget(
  spaceId: string,
  userId: string,
  requiredRole: string,
  target: { type: ResourceType; id: string },
): Promise<void> {
  if (target.type === ResourceType.DOCUMENT) {
    await verifyDocumentRole(spaceId, target.id, userId, requiredRole);
  } else {
    await verifySpaceRole(spaceId, userId, requiredRole);
  }
}

/**
 * Authenticate a request that may originate from:
 *  - an HMAC job token (`X-Job-Token`) — a server-minted credential that
 *    carries the initiating user's id. When a user id is present the token is
 *    NOT trusted blindly: it is scoped to exactly what that user may do on the
 *    target (a token minted at space-viewer level — e.g. by the MCP endpoint —
 *    must not become a skeleton key for documents the user cannot access).
 *    A user-less token (`userId === null`) is a system/background credential
 *    and remains fully trusted within its space;
 *  - a space access token (`Authorization: Bearer at_...`) — a long-lived
 *    credential whose authority is defined entirely by its ACL entries
 *    (`token:<id>`); or
 *  - a logged-in user session.
 *
 * For every credential that carries a user identity we MUST verify it actually
 * holds `requiredRole` on the target resource. By default the target is the
 * space itself; pass `resource` to check a more specific node (e.g. a document)
 * so resource-scoped credentials are neither over- nor under-privileged.
 */
export async function authenticateJobTokenOrSpaceRole(
  context: APIContext,
  spaceId: string,
  requiredRole: string,
  resource?: { type: ResourceType; id: string },
): Promise<
  | { type: "job"; userId: string | null }
  | { type: "user"; user: NonNullable<APIContext["locals"]["user"]> }
> {
  const target = resource ?? { type: ResourceType.SPACE, id: spaceId };

  const jobToken = context.request.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    // A token carrying a user id only grants that user's real access. Only
    // user-less system tokens keep the historical "fully trusted" behaviour.
    if (parsed.userId) {
      await enforceUserRoleOnTarget(spaceId, parsed.userId, requiredRole, target);
    }
    return { type: "job", userId: parsed.userId };
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    // Access tokens are NOT trusted job tokens: their authority is whatever the
    // ACL grants `token:<id>`. Enforce the required role before proceeding,
    // otherwise any valid (even viewer-scoped) token passes write gates.
    await verifyTokenPermission(
      tokenResult,
      spaceId,
      target.type,
      target.id,
      requiredRole,
    );
    return { type: "job", userId: getTokenUserId(tokenResult.tokenId) };
  }

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, requiredRole);
  return { type: "user", user };
}

import type { APIContext } from "astro";
import {
  forbiddenResponse,
  requireUser,
  verifySpaceRole,
  authenticateWithToken,
  verifyTokenPermission,
} from "#db/api.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import { ResourceType } from "#db/acl.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

/**
 * Authenticate a request that may originate from:
 *  - an HMAC job token (`X-Job-Token`) — a server-minted, trusted credential
 *    that carries the initiating user's id and is fully scoped by the caller
 *    that issued it;
 *  - a space access token (`Authorization: Bearer at_...`) — a long-lived
 *    credential whose authority is defined entirely by its ACL entries
 *    (`token:<id>`); or
 *  - a logged-in user session.
 *
 * For access tokens and user sessions we MUST verify the credential actually
 * holds `requiredRole` on the target resource. By default the target is the
 * space itself; pass `resource` to check a more specific node (e.g. a document)
 * so resource-scoped tokens are neither over- nor under-privileged.
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

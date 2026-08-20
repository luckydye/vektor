/**
 * The seam between an HTTP request and the authorization core.
 *
 * `#acl` decides; this translates. Two directions, and nothing else belongs
 * here: {@link requestCredentials} turns a Hono context into the plain
 * {@link RequestCredentials} the guards read, and {@link accessDenialResponse}
 * turns a non-`ok` decision into the Response a route answers with.
 *
 * The translation lives here rather than beside the decision because the two
 * answer different questions. A decision says "denied"; only the request edge
 * knows that a denied caller who never authenticated should hear 401 rather
 * than 403, or that a missing space is a 404 — and reading any of that back off
 * a thrown Response confuses "not allowed" with "not authenticated".
 */

import type { AccessDecision, AclTarget } from "#acl/guards.ts";
import type { ResolvedIdentity } from "#acl/identity.ts";
import type { Permission } from "#acl/permissions.ts";
import { forbiddenResponse, notFoundResponse, unauthorizedResponse } from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { hasCredentialGrant } from "#db/space/accessTokens.ts";

/** The three things a guard reads off a request, and nothing more. */
export function requestCredentials(context: ApiContext) {
  return {
    jobToken: context.req.raw.headers.get("X-Job-Token"),
    authorization: context.req.raw.headers.get("Authorization"),
    user: context.var.user,
  };
}

/**
 * The Response a non-`ok` decision answers with.
 *
 * @param decided The decision, and the role it was actually decided at — which
 *   an archived document raises above the one that was asked for.
 */
export async function accessDenialResponse(
  spaceId: string,
  decided: { decision: AccessDecision; requiredRole: Permission },
  target: AclTarget,
  identity: ResolvedIdentity,
): Promise<Response> {
  if (decided.decision === "no-space") return notFoundResponse("Space");
  if (decided.decision === "no-document") return notFoundResponse("Document");

  // An unauthenticated caller is told to authenticate; anyone else is told no.
  if (!identity.userId) return unauthorizedResponse();
  // A credential hears which role it lacked, since whoever integrated it owns
  // both ends of the call. Only asked on the refusal path, where a query costs
  // nothing, so this needs no guess about what the id looks like.
  if (await hasCredentialGrant(await openSpaceStore(spaceId), identity.userId)) {
    return forbiddenResponse(
      `This credential does not have ${decided.requiredRole} permission for this ${target.type}`,
    );
  }
  return forbiddenResponse();
}

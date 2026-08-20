/**
 * Who a request is, resolved once and then handed to every decision it makes.
 *
 * Resolving an identity is the expensive half of authorization: reading a user's
 * groups bounds how stale the IdP's claim may be, and on the slow path that is
 * an outbound HTTP call. That cost belongs to the request, not to the check —
 * a route gating four resources must not pay it four times, and a decision must
 * never be the thing that goes to the network.
 *
 * So the resolution happens at the request edge ({@link withIdentityScope},
 * installed by the API router) and the result travels as a {@link
 * ResolvedIdentity}. {@link import("#acl/guards.ts").decideAccess} takes one and
 * cannot fetch: everything it needs — the principal, its groups, whether it
 * administers the instance — is already in hand.
 */

import { adminGroups, adminGroupsIn, spaceCreationGroups } from "#acl/instanceGroups.ts";
import { PUBLIC_GROUP } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { forbiddenResponse } from "#api/http.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#config";
import { createRequestScope } from "#utils/requestScope.ts";

/**
 * An identity an authorization decision can be made against, with nothing left
 * to look up.
 */
export interface ResolvedIdentity {
  /**
   * The {@link import("#acl/guards.ts").SpaceAccess.aclUserId} convention:
   * `null` or `""` is unauthenticated, a `token_` id a credential, anything
   * else a user.
   */
  userId: string | null;
  /**
   * The groups an ACL question resolves against: `public` for an
   * unauthenticated caller, and a user's own groups otherwise — which for a
   * credential is empty, since its id has no row in the user table.
   *
   * There is deliberately no test for a credential here. An empty group set is
   * read as `[public]` by every query that takes one (see `getPermission`), so a
   * credential resolves against `public` whichever way this answers, and a
   * `token_` test would only claim otherwise. Everything beyond world-readable
   * is the grants written for the credential's own id.
   */
  groups: string[];
  /**
   * Whether this identity administers the instance, which is owner on every
   * space that exists. Only a user identity can be one: a credential's id
   * belongs to no user and so carries no groups, which is why a token minted by
   * an admin is not a skeleton key.
   */
  isInstanceAdmin: boolean;
}

/** The ACL principal a decision queries with; `""` for an anonymous caller. */
export function principalOf(identity: ResolvedIdentity): string {
  return identity.userId || "";
}

/** An identity, or the id one still has to be resolved from. */
export type AccessIdentity = string | null | ResolvedIdentity;

/** Narrow an {@link AccessIdentity}, resolving it only when it is still an id. */
export async function toIdentity(who: AccessIdentity): Promise<ResolvedIdentity> {
  if (who === null || typeof who === "string") return await resolveIdentity(who);
  return who;
}

/** Shared, so frozen: every anonymous caller is handed this same object. */
const ANONYMOUS: ResolvedIdentity = Object.freeze({
  userId: null,
  groups: Object.freeze([PUBLIC_GROUP]) as string[],
  isInstanceAdmin: false,
});

/**
 * One cache per request, so a route that gates several resources resolves each
 * identity once. Request-scoped rather than global on purpose: the staleness
 * bound the IdP sync exists for is what makes the cache safe, and a cache that
 * outlived the request would remove it.
 */
const identities = createRequestScope<ResolvedIdentity>();

/**
 * Run `handler` with a fresh identity cache. Installed around one HTTP request,
 * and nothing longer-lived: a websocket connection lasts days, and holding a
 * group claim for its lifetime is exactly what {@link
 * import("#acl/idpSync.ts").ensureFreshGroups} bounds.
 */
export function withIdentityScope<T>(handler: () => T): T {
  return identities.within(handler);
}

/**
 * The identity behind an id. Within a {@link withIdentityScope} this answers
 * from the request's cache after the first call, which is what keeps the IdP
 * round-trip on the request edge rather than on every check.
 */
export function resolveIdentity(userId: string | null): Promise<ResolvedIdentity> {
  return identities.memoize(userId ?? "", () => resolveUncached(userId));
}

async function resolveUncached(userId: string | null): Promise<ResolvedIdentity> {
  if (!userId) return ANONYMOUS;

  const groups = await getUserGroups(userId);
  return {
    userId,
    groups,
    isInstanceAdmin:
      (isNoAuthMode() && userId === LOCAL_USER_ID) || adminGroupsIn(groups).length > 0,
  };
}

/**
 * Whether `userId` administers the instance. The id-taking form, for a caller
 * at the request edge that holds nothing else; a decision reads
 * {@link ResolvedIdentity.isInstanceAdmin} instead of asking again.
 *
 * The two short-circuits are what keep an instance with no admin groups
 * configured — the common case — from reading a group set to answer "no".
 */
export async function isInstanceAdmin(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return true;
  if (adminGroups().length === 0) return false;

  return (await resolveIdentity(userId)).isInstanceAdmin;
}

/**
 * The admin groups this user is actually in. Only their own: the configured list
 * is the operator's, and a client that has to name a group when it writes a
 * grant needs no more than the ones it already belongs to.
 */
export async function userAdminGroups(userId: string): Promise<string[]> {
  if (adminGroups().length === 0) return [];
  return adminGroupsIn((await resolveIdentity(userId)).groups);
}

/**
 * Whether `userId` may create a space. An instance admin always may: they can
 * already delete and re-own every space that exists.
 */
export async function canCreateSpace(userId: string): Promise<boolean> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return true;

  const allowed = spaceCreationGroups();
  if (allowed === null) return true;

  const identity = await resolveIdentity(userId);
  if (allowed.length > 0 && identity.groups.some((group) => allowed.includes(group))) {
    return true;
  }

  return identity.isInstanceAdmin;
}

/** The enforcement form of {@link canCreateSpace}; throws 403 like the guards. */
export async function verifyCanCreateSpace(userId: string): Promise<void> {
  if (await canCreateSpace(userId)) return;
  throw forbiddenResponse("You are not allowed to create spaces");
}

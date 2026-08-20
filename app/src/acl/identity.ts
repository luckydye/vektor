/**
 * Who a request is, resolved once at the request edge and then handed to every
 * decision it makes.
 *
 * Reading a user's groups bounds how stale the IdP's claim may be, and on the
 * slow path that is an outbound HTTP call — a cost that belongs to the request,
 * not to each check inside it.
 */

import {
  adminGroups,
  adminGroupsIn,
  maxSpacesPerUser,
  spaceCreationGroups,
} from "#acl/instanceGroups.ts";
import { PUBLIC_GROUP } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#config";
import { countSpacesCreatedBy } from "#db/auth/spaceIndex.ts";
import { createRequestScope } from "#utils/requestScope.ts";

/** An identity a decision can be made against, with nothing left to look up. */
export interface ResolvedIdentity {
  /**
   * The {@link import("#acl/guards.ts").SpaceAccess.aclUserId} convention:
   * `null` or `""` is unauthenticated, a `token_` id a credential, anything
   * else a user.
   */
  userId: string | null;
  /**
   * `public` for an unauthenticated caller, a user's own groups otherwise, and
   * empty for a credential — whose id has no row in the user table. Deliberately
   * untested for a credential: every query reads empty as `[public]` anyway, so
   * a `token_` test would only claim otherwise.
   */
  groups: string[];
  /**
   * Whether this identity is owner on every space that exists. Only a user can
   * be: a credential carries no groups, so an admin's token is not a skeleton
   * key.
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
 * Request-scoped rather than global on purpose: the IdP staleness bound is what
 * makes the cache safe, and outliving the request would remove it.
 */
const identities = createRequestScope<ResolvedIdentity>();

/**
 * Run `handler` with a fresh identity cache. Installed around one HTTP request
 * and nothing longer-lived: a websocket lasts days, and holding a group claim
 * that long is what `ensureFreshGroups` exists to bound.
 */
export function withIdentityScope<T>(handler: () => T): T {
  return identities.within(handler);
}

/**
 * The identity behind an id, answered from the request's cache after the first
 * call. Outside a scope every call resolves, as it did before the cache existed.
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
 * Whether `userId` administers the instance, for a caller holding nothing but an
 * id; a decision reads {@link ResolvedIdentity.isInstanceAdmin} instead. The two
 * short-circuits keep an instance with no admin groups from reading a group set
 * to answer "no".
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
  return (await spaceCreationRejection(userId)) === null;
}

/**
 * Why this user may not create a space, phrased for the caller, or `null` when
 * they may. Two gates rather than one: the allow list says who, the quota says
 * how many, and a user who reaches the second is told so instead of being read
 * as unauthorized.
 */
export async function spaceCreationRejection(userId: string): Promise<string | null> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return null;

  const identity = await resolveIdentity(userId);
  // An admin owns every space that exists; a cap on the ones they created would
  // bound nothing.
  if (identity.isInstanceAdmin) return null;

  if (!allowedToCreateSpaces(identity)) {
    return "You are not allowed to create spaces";
  }

  const limit = maxSpacesPerUser();
  if (limit > 0 && (await countSpacesCreatedBy(userId)) >= limit) {
    return `You have reached the limit of ${limit} spaces; delete one to create another`;
  }

  return null;
}

function allowedToCreateSpaces(identity: ResolvedIdentity): boolean {
  const allowed = spaceCreationGroups();
  if (allowed === null) return true;
  return allowed.length > 0 && identity.groups.some((group) => allowed.includes(group));
}

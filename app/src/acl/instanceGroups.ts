/**
 * The two gates that cannot be ACL grants, because neither has a resource to
 * hang off: who may create a space that does not exist yet, and who administers
 * every space at once. Both are operator configuration — a comma-separated
 * allow list of OAuth group ids — and both resolve membership through
 * `getUserGroups`, so the same staleness bound and name validation apply as to
 * every other authorization decision.
 */

import { GROUP_NAME_PATTERN, PUBLIC_GROUP } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { forbiddenResponse } from "#api/http.ts";
import { config, isNoAuthMode, LOCAL_USER_ID } from "#config";

/**
 * The group ids a raw setting names, or `null` when it names nothing. An empty
 * array is a real answer — "no one" — and is what a list naming only unusable
 * entries collapses to, so a typo cannot widen either gate.
 */
function configuredGroups(raw: string | undefined): string[] | null {
  const configured = raw?.trim();
  if (!configured) return null;

  return (
    configured
      .split(",")
      .map((group) => group.trim())
      // `public` is the synthetic group every caller carries, so honouring it
      // would make a list that reads as configured admit the whole instance.
      .filter((group) => group !== PUBLIC_GROUP && GROUP_NAME_PATTERN.test(group))
  );
}

/**
 * The groups that may create a space, or `null` when creation is open to every
 * signed-in user. Unset has to mean "open" here: that is what an instance
 * without the setting has always done.
 */
export function spaceCreationGroups(): string[] | null {
  return configuredGroups(config().SPACE_CREATION_GROUPS);
}

/**
 * The groups whose members administer the instance. Unset means nobody, the
 * opposite of {@link spaceCreationGroups} — an absent setting cannot hand
 * everyone authority over every space.
 */
export function adminGroups(): string[] {
  return configuredGroups(config().ADMIN_GROUPS) ?? [];
}

/**
 * The admin groups this user is actually in. Only their own: the configured list
 * is the operator's, and a client that has to name a group when it writes a
 * grant needs no more than the ones it already belongs to.
 */
export async function userAdminGroups(userId: string): Promise<string[]> {
  const admins = adminGroups();
  if (admins.length === 0) return [];

  const groups = await getUserGroups(userId);
  return admins.filter((group) => groups.includes(group));
}

/**
 * Whether `userId` administers the instance, which is owner on every space that
 * exists — see {@link import("#acl/guards.ts").canAccess}. Only a user identity
 * can be one: a credential's id belongs to no user and so carries no groups,
 * which is why a token minted by an admin is not a skeleton key.
 */
export async function isInstanceAdmin(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return true;

  return (await userAdminGroups(userId)).length > 0;
}

/**
 * Whether `userId` may create a space. An instance admin always may: they can
 * already delete and re-own every space that exists.
 */
export async function canCreateSpace(userId: string): Promise<boolean> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return true;

  const allowed = spaceCreationGroups();
  if (allowed === null) return true;

  const groups = await getUserGroups(userId);
  if (allowed.length > 0 && groups.some((group) => allowed.includes(group))) return true;

  return await isInstanceAdmin(userId);
}

/** The enforcement form of {@link canCreateSpace}; throws 403 like the guards. */
export async function verifyCanCreateSpace(userId: string): Promise<void> {
  if (await canCreateSpace(userId)) return;
  throw forbiddenResponse("You are not allowed to create spaces");
}

/**
 * Who may create a space.
 *
 * Every other privileged action hangs off an ACL grant on the resource it
 * touches, but a space that does not exist yet has nothing to grant on. So this
 * one gate is operator configuration rather than ACL: an allow list of OAuth
 * group ids, unset by default so creation stays open to every signed-in user.
 */

import { GROUP_NAME_PATTERN, PUBLIC_GROUP } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/store.ts";
import { forbiddenResponse } from "#api/http.ts";
import { config } from "#config";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";

/**
 * The configured group ids, or `null` when creation is open to everyone.
 *
 * An empty array is a real answer — "no one" — and is what a list naming only
 * unusable entries collapses to. Falling back to `null` there would let a typo
 * silently reopen creation to the whole instance, so the failure is closed.
 *
 * `public` is dropped rather than honoured: it is the synthetic group every
 * caller carries, including unauthenticated ones, so accepting it would make an
 * allow list that reads as configured behave as if it were absent.
 */
export function spaceCreationGroups(): string[] | null {
  const configured = config().SPACE_CREATION_GROUPS?.trim();
  if (!configured) return null;

  return configured
    .split(",")
    .map((group) => group.trim())
    .filter((group) => group !== PUBLIC_GROUP && GROUP_NAME_PATTERN.test(group));
}

/**
 * Whether `userId` may create a space. Groups are read through `getUserGroups`
 * like every other authorization decision, so the same staleness bound and the
 * same name validation apply.
 */
export async function canCreateSpace(userId: string): Promise<boolean> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return true;

  const allowed = spaceCreationGroups();
  if (allowed === null) return true;
  if (allowed.length === 0) return false;

  const groups = await getUserGroups(userId);
  return groups.some((group) => allowed.includes(group));
}

/** The enforcement form of {@link canCreateSpace}; throws 403 like the guards. */
export async function verifyCanCreateSpace(userId: string): Promise<void> {
  if (await canCreateSpace(userId)) return;
  throw forbiddenResponse("You are not allowed to create spaces");
}

/**
 * The gates that cannot be ACL grants, because none has a resource to hang off:
 * who may create a space that does not exist yet, how many they may end up
 * owning, and who administers every space at once. All three are operator
 * configuration — a comma-separated allow list of OAuth group ids, or a count.
 *
 * Configuration only: whether a caller is in one of these lists is asked in
 * `#acl/identity.ts`, so the resolution path can read this without it depending
 * on the resolution path in turn.
 */

import { GROUP_NAME_PATTERN, PUBLIC_GROUP } from "#acl/permissions.ts";
import { config } from "#config";

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

/** Spaces one user may have created, when the operator configured no other. */
const DEFAULT_MAX_SPACES_PER_USER = 50;

/**
 * How many spaces one user may have created and still own; `0` lifts the cap.
 * Unset cannot mean "unlimited" the way it does above: every space allocates a
 * database of its own, so no ceiling is a disk and file-descriptor budget
 * handed to whoever can sign up.
 */
export function maxSpacesPerUser(): number {
  const configured = config().MAX_SPACES_PER_USER?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_MAX_SPACES_PER_USER;
  return Number.parseInt(configured, 10);
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
 * Which of `groups` administer the instance. Pure: it decides nothing about a
 * caller on its own, it reads the operator's list against a group set someone
 * else resolved.
 */
export function adminGroupsIn(groups: readonly string[]): string[] {
  const admins = adminGroups();
  if (admins.length === 0) return [];
  return admins.filter((group) => groups.includes(group));
}

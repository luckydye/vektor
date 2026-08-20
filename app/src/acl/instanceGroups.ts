/**
 * The two gates that cannot be ACL grants, because neither has a resource to
 * hang off: who may create a space that does not exist yet, and who administers
 * every space at once. Both are operator configuration — a comma-separated
 * allow list of OAuth group ids.
 *
 * Configuration only. Whether a given caller is in one of these lists is a
 * question about an identity, and lives with the identity it is asked of, in
 * `#acl/identity.ts` — so this module can be read from the resolution path
 * without depending on it in turn.
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

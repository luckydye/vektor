/**
 * Who the people behind the grants are: the reads that answer with names,
 * emails and memberships rather than with a verdict.
 *
 * Its own module rather than part of `#acl/store.ts`, because none of it is a
 * decision. The store answers "may this principal do this", from a space's
 * `acl` table and a group set handed to it; everything here reaches into the
 * auth database for the directory behind those ids — invite suggestions, an
 * audit entry's display name, a space's member list. Keeping them apart leaves
 * `auth.db` to better-auth and this module, and makes the decision core's
 * independence from it structural rather than a convention.
 */

import { and, eq, like, or } from "drizzle-orm";
import { GROUP_NAME_PATTERN, PUBLIC_GROUP, ResourceType } from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { getAuthDb } from "#db/client/db.ts";
import { many, one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import { acl } from "#db/schema/space.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

/**
 * Minimal profile of a user who shares an OAuth group with the caller. Email is
 * included because these results feed invite suggestions, and email is what the
 * inviter picks by (and what the permissions endpoint resolves to a user id).
 */
export interface GroupPeer {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/**
 * Users who share at least one real OAuth group with `userId`.
 *
 * This is the "same OAuth group ⇒ visible to each other" rule: membership in a
 * common IdP group is treated as an organizational boundary within which people
 * may see one another (name + email) for invite suggestions. Users only ever
 * appear to peers in their own groups — there is deliberately no global user
 * directory. The synthetic `public` group is excluded (everyone is in it, so it
 * would leak the whole instance), and a user with no real groups sees nobody.
 */
export async function getUsersInSharedGroups(userId: string): Promise<GroupPeer[]> {
  const authDb = getAuthDb();
  if (!authDb) return [];

  const groups = (await getUserGroups(userId)).filter((g) => g !== PUBLIC_GROUP);
  if (groups.length === 0) return [];

  // Group names are sanitized to GROUP_NAME_PATTERN (no `"`), so the JSON-quoted
  // token match below is exact per group and cannot be fooled by a name that is
  // a prefix of another (`"dev"` never matches inside `"developers"`).
  const conditions = groups.map((groupId) => like(user.groups, `%"${groupId}"%`));

  const rows = await many(
    authDb
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        groups: user.groups,
      })
      .from(user)
      .where(or(...conditions)),
  );

  const groupSet = new Set(groups);

  return (
    rows
      .filter((row) => row.id !== userId)
      // Defense in depth: confirm a genuinely shared, well-formed group rather
      // than trusting the coarse LIKE prefilter alone.
      .filter((row) => {
        if (!row.groups) return false;
        try {
          const parsed = JSON.parse(row.groups);
          return (
            Array.isArray(parsed) &&
            parsed.some(
              (g): g is string =>
                typeof g === "string" && GROUP_NAME_PATTERN.test(g) && groupSet.has(g),
            )
          );
        } catch {
          return false;
        }
      })
      .map(({ id, name, email, image }) => ({
        id,
        name,
        email,
        image: resolveProfileImage({ email, image }),
      }))
  );
}

/**
 * Display name of a grantee, captured when the permission change is logged so
 * the audit entry stays readable after the account is renamed or removed.
 */
export async function resolveGranteeName(userId?: string): Promise<string | undefined> {
  if (!userId) return undefined;
  const authDb = getAuthDb();
  if (!authDb) return undefined;
  try {
    const record = await one(
      authDb
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, userId)),
    );
    return record?.name || record?.email || undefined;
  } catch {
    return undefined;
  }
}

export async function countSpaceMembers(spaceId: string): Promise<number> {
  const memberIds = await getSpaceMemberIds(spaceId);
  return memberIds.size;
}

/**
 * Get all user IDs that have access to a space, including users from groups.
 * Returns a Set of user IDs that have either direct access or access through group membership.
 *
 * @param spaceId - The space ID
 * @returns Set of user IDs with access to the space
 */
export async function getSpaceMemberIds(spaceId: string): Promise<Set<string>> {
  const { db } = await openSpaceStore(spaceId);
  const authDb = getAuthDb();

  const results = await many(
    db
      .select()
      .from(acl)
      .where(and(eq(acl.resourceType, ResourceType.SPACE), eq(acl.resourceId, spaceId))),
  );

  const memberIds = new Set<string>();
  const groupsToCheck: string[] = [];

  for (const entry of results) {
    // A token holds a grant but is not a member — it is a credential one of
    // them issued, and counting it would inflate the space's membership.
    if (entry.userId && !entry.kind) {
      memberIds.add(entry.userId);
    }
    if (entry.groupId) {
      groupsToCheck.push(entry.groupId);
    }
  }

  if (groupsToCheck.length > 0) {
    const conditions = groupsToCheck.map((groupId) =>
      like(user.groups, `%"${groupId}"%`),
    );

    const groupMembers = await many(
      authDb
        .select({ id: user.id })
        .from(user)
        .where(or(...conditions)),
    );

    for (const member of groupMembers) {
      memberIds.add(member.id);
    }
  }

  return memberIds;
}

/**
 * Get space members with their group associations.
 * Returns a map of user IDs to their associated group IDs (if they have access through a group).
 *
 * @param spaceId - The space ID
 * @returns Object containing direct user IDs, group members map, and groups to check
 */
export async function getSpaceMembersWithGroups(spaceId: string): Promise<{
  directUserIds: Set<string>;
  groupMembers: Map<string, string[]>; // userId -> groupIds
  groupsToCheck: string[];
}> {
  const { db } = await openSpaceStore(spaceId);
  const authDb = getAuthDb();

  const results = await many(
    db
      .select()
      .from(acl)
      .where(and(eq(acl.resourceType, ResourceType.SPACE), eq(acl.resourceId, spaceId))),
  );

  const directUserIds = new Set<string>();
  const groupsToCheck: string[] = [];

  for (const entry of results) {
    if (entry.userId) {
      directUserIds.add(entry.userId);
    }
    if (entry.groupId) {
      groupsToCheck.push(entry.groupId);
    }
  }

  const groupMembers = new Map<string, string[]>();

  if (groupsToCheck.length > 0) {
    const conditions = groupsToCheck.map((groupId) =>
      like(user.groups, `%"${groupId}"%`),
    );

    const members = await many(
      authDb
        .select({ id: user.id, groups: user.groups })
        .from(user)
        .where(or(...conditions)),
    );

    for (const member of members) {
      if (!directUserIds.has(member.id)) {
        const memberGroupIds: string[] = [];
        for (const groupId of groupsToCheck) {
          if (member.groups?.includes(`"${groupId}"`)) {
            memberGroupIds.push(groupId);
          }
        }
        if (memberGroupIds.length > 0) {
          groupMembers.set(member.id, memberGroupIds);
        }
      }
    }
  }

  return { directUserIds, groupMembers, groupsToCheck };
}

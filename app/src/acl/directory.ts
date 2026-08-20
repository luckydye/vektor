/**
 * Who the people behind the grants are: the reads that answer with names,
 * emails and memberships rather than with a verdict.
 *
 * Its own module because none of it is a decision — the store answers "may this
 * principal do this" from a space's `acl` table and a group set handed to it,
 * while everything here reaches into the auth database for the directory behind
 * those ids.
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

/** A user row as the group expansion below hands it out. */
interface GroupMemberRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  /** The queried groups this user genuinely carries. */
  groups: string[];
}

/**
 * Everyone whose stored group claim names at least one of `groupIds`.
 *
 * The single place a group id becomes people: an ACL grant to a group only says
 * which claim opens the door, so every caller that needs the people behind such
 * a grant — a space's members, a document's, the invite typeahead — resolves it
 * here. Nothing is found for the synthetic `public` group, which no stored claim
 * carries.
 */
async function usersInGroups(groupIds: readonly string[]): Promise<GroupMemberRow[]> {
  const authDb = getAuthDb();
  if (!authDb || groupIds.length === 0) return [];

  // Group names are sanitized to GROUP_NAME_PATTERN (no `"`), so the JSON-quoted
  // token match below is exact per group and cannot be fooled by a name that is
  // a prefix of another (`"dev"` never matches inside `"developers"`).
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
      .where(or(...groupIds.map((groupId) => like(user.groups, `%"${groupId}"%`)))),
  );

  const wanted = new Set(groupIds);

  return rows.flatMap((row) => {
    // Defense in depth: confirm genuinely carried, well-formed groups rather
    // than trusting the coarse LIKE prefilter alone.
    let carried: string[] = [];
    try {
      const parsed = row.groups ? JSON.parse(row.groups) : [];
      if (Array.isArray(parsed)) {
        carried = parsed.filter(
          (g): g is string =>
            typeof g === "string" && GROUP_NAME_PATTERN.test(g) && wanted.has(g),
        );
      }
    } catch {
      return [];
    }
    if (carried.length === 0) return [];
    return [{ ...row, groups: carried }];
  });
}

/** Ids of everyone who reaches a resource through one of `groupIds`. */
export async function getGroupMemberIds(
  groupIds: readonly string[],
): Promise<Set<string>> {
  const rows = await usersInGroups(groupIds);
  return new Set(rows.map((row) => row.id));
}

/**
 * Users who share at least one real OAuth group with `userId`.
 *
 * A shared IdP group is the boundary within which people may see one another
 * (name + email) for invite suggestions; there is deliberately no global user
 * directory. The synthetic `public` group is excluded — everyone is in it, so it
 * would leak the instance — and a user with no real groups sees nobody.
 */
export async function getUsersInSharedGroups(userId: string): Promise<GroupPeer[]> {
  const groups = (await getUserGroups(userId)).filter((g) => g !== PUBLIC_GROUP);
  const peers = await usersInGroups(groups);

  return peers
    .filter((row) => row.id !== userId)
    .map(({ id, name, email, image }) => ({
      id,
      name,
      email,
      image: resolveProfileImage({ email, image }),
    }));
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

  for (const memberId of await getGroupMemberIds(groupsToCheck)) {
    memberIds.add(memberId);
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

  for (const member of await usersInGroups(groupsToCheck)) {
    if (!directUserIds.has(member.id)) {
      groupMembers.set(member.id, member.groups);
    }
  }

  return { directUserIds, groupMembers, groupsToCheck };
}

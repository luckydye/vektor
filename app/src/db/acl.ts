import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { createAuditLog } from "./auditLogs.ts";
import { getSpaceDb, getAuthDb } from "./db.ts";
import { acl } from "./schema/space.ts";
import { document, spaceMetadata } from "./schema/space.ts";
import { user } from "./schema/auth.ts";

export interface AclEntry {
  resourceType: string;
  resourceId: string;
  userId?: string;
  groupId?: string;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
}

export const ResourceType = {
  SPACE: "space",
  DOCUMENT: "document",
  CATEGORY: "category",
  EXTENSION: "extension",
  FEATURE: "feature",
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

// Feature-based permissions that can be granted/denied independently of role
export const Feature = {
  COMMENT: "comment",
  VIEW_HISTORY: "view_history",
  VIEW_AUDIT: "view_audit",
  MANAGE_EXTENSIONS: "manage_extensions",
} as const;

export type Feature = (typeof Feature)[keyof typeof Feature];

// Default features granted based on space permission level
// These are used when no explicit feature ACL entry exists
const DEFAULT_FEATURES: Record<string, Feature[]> = {
  owner: [
    Feature.COMMENT,
    Feature.VIEW_HISTORY,
    Feature.VIEW_AUDIT,
    Feature.MANAGE_EXTENSIONS,
  ],
  editor: [Feature.COMMENT, Feature.VIEW_HISTORY],
  viewer: [],
};

export const Permission = {
  VIEWER: "viewer",
  EDITOR: "editor",
  OWNER: "owner",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const PERMISSION_HIERARCHY: Record<string, number> = {
  viewer: 1,
  editor: 3,
  owner: 5,
};

export async function getUserGroups(userId: string): Promise<string[]> {
  const authDb = getAuthDb();
  if (!authDb) {
    return ["public"];
  }

  const userRecord = await authDb.select().from(user).where(eq(user.id, userId)).get();

  const groups = ["public"];

  if (userRecord?.groups) {
    try {
      const userGroups = JSON.parse(userRecord.groups);
      groups.push(...userGroups);
    } catch {
      // Keep just "public"
    }
  }

  return groups;
}

export async function grantPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string | undefined,
  permission: string,
  groupId?: string,
): Promise<AclEntry> {
  if (!userId && !groupId) {
    throw new Error("Either userId or groupId must be provided");
  }

  const db = await getSpaceDb(spaceId);
  const now = new Date();

  // Check if permission already exists
  const conditions = [eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId)];

  if (userId) {
    conditions.push(eq(acl.userId, userId));
    conditions.push(isNull(acl.groupId));
  } else if (groupId) {
    conditions.push(isNull(acl.userId));
    conditions.push(eq(acl.groupId, groupId));
  }

  const existing = await db
    .select()
    .from(acl)
    .where(and(...conditions))
    .get();

  if (existing) {
    // Update existing permission
    await db
      .update(acl)
      .set({ permission, updatedAt: now })
      .where(and(...conditions));
  } else {
    // Insert new permission
    await db.insert(acl).values({
      resourceType,
      resourceId,
      userId: userId || null,
      groupId: groupId || null,
      permission,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (resourceType === ResourceType.DOCUMENT) {
    await createAuditLog(db, {
      docId: resourceId,
      userId: undefined,
      event: "acl_grant",
      details: {
        message: `Granted ${permission} permission to ${userId ? `user ${userId}` : `group ${groupId}`}`,
        permission,
      },
    });
  }

  return {
    resourceType,
    resourceId,
    userId,
    groupId,
    permission,
    createdAt: now,
    updatedAt: now,
  };
}

export async function revokePermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId?: string,
  groupId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  const conditions = [eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId)];

  if (userId) {
    conditions.push(eq(acl.userId, userId));
  }
  if (groupId) {
    conditions.push(eq(acl.groupId, groupId));
  }

  await db.delete(acl).where(and(...conditions));

  if (resourceType === ResourceType.DOCUMENT) {
    await createAuditLog(db, {
      docId: resourceId,
      userId: undefined,
      event: "acl_revoke",
      details: {
        message: `Revoked permission from ${userId ? `user ${userId}` : `group ${groupId}`}`,
      },
    });
  }

  return true;
}

export async function getPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  userGroups?: string[],
): Promise<AclEntry | null> {
  const db = await getSpaceDb(spaceId);

  const allPermissions: Array<{
    resourceType: string;
    resourceId: string;
    userId: string | null;
    groupId: string | null;
    permission: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  // Get user-specific permission
  const userResult = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        eq(acl.resourceId, resourceId),
        eq(acl.userId, userId),
        isNull(acl.groupId),
      ),
    )
    .get();

  if (userResult) {
    allPermissions.push(userResult);
  }

  // Always include "public" in group checks to support public access
  const effectiveGroups = userGroups && userGroups.length > 0 ? userGroups : ["public"];

  // Get group-based permissions (including "public")
  const groupResults = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        eq(acl.resourceId, resourceId),
        isNull(acl.userId),
        inArray(acl.groupId, effectiveGroups),
      ),
    )
    .all();

  allPermissions.push(...groupResults);

  // If no permissions found, return null
  if (allPermissions.length === 0) {
    return null;
  }

  // Return the highest permission level from all applicable permissions
  const sortedResults = allPermissions.sort((a, b) => {
    const levelA = PERMISSION_HIERARCHY[a.permission] || 0;
    const levelB = PERMISSION_HIERARCHY[b.permission] || 0;
    return levelB - levelA;
  });

  const result = sortedResults[0];
  return {
    resourceType: result.resourceType,
    resourceId: result.resourceId,
    userId: result.userId || undefined,
    groupId: result.groupId || undefined,
    permission: result.permission,
    createdAt: new Date(result.createdAt),
    updatedAt: new Date(result.updatedAt),
  };
}

export async function listPermissions(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<AclEntry[]> {
  const db = await getSpaceDb(spaceId);

  const results = await db
    .select()
    .from(acl)
    .where(and(eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId)))
    .all();

  return results.map((r) => ({
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    userId: r.userId || undefined,
    groupId: r.groupId || undefined,
    permission: r.permission,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  }));
}

export async function listUserPermissions(
  spaceId: string,
  userId: string,
  userGroups?: string[],
  resourceType?: ResourceType,
): Promise<AclEntry[]> {
  const db = await getSpaceDb(spaceId);

  const conditions = [eq(acl.userId, userId)];
  if (resourceType) {
    conditions.push(eq(acl.resourceType, resourceType));
  }

  const results = await db
    .select()
    .from(acl)
    .where(and(...conditions))
    .all();

  // Also get group-based permissions
  if (userGroups && userGroups.length > 0) {
    const groupConditions = [isNull(acl.userId), inArray(acl.groupId, userGroups)];
    if (resourceType) {
      groupConditions.push(eq(acl.resourceType, resourceType));
    }

    const groupResults = await db
      .select()
      .from(acl)
      .where(and(...groupConditions))
      .all();

    results.push(...groupResults);
  }

  return results.map((r) => ({
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    userId: r.userId || undefined,
    groupId: r.groupId || undefined,
    permission: r.permission,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  }));
}

export async function hasPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  requiredPermission: string,
  userGroups?: string[],
): Promise<boolean> {
  const userPermission = await getPermission(
    spaceId,
    resourceType,
    resourceId,
    userId,
    userGroups,
  );

  if (!userPermission) {
    // For documents and extensions, fall back to space-level permission
    if (
      resourceType === ResourceType.DOCUMENT ||
      resourceType === ResourceType.EXTENSION
    ) {
      const spacePermission = await getPermission(
        spaceId,
        ResourceType.SPACE,
        spaceId,
        userId,
        userGroups,
      );

      if (
        spacePermission &&
        meetsPermissionLevel(spacePermission.permission, requiredPermission)
      ) {
        return true;
      }
    }

    return false;
  }

  return meetsPermissionLevel(userPermission.permission, requiredPermission);
}

export function meetsPermissionLevel(
  userPermission: string,
  requiredPermission: string,
): boolean {
  const userLevel = PERMISSION_HIERARCHY[userPermission] || 0;
  const requiredLevel = PERMISSION_HIERARCHY[requiredPermission] || 0;

  return userLevel >= requiredLevel;
}

/**
 * Check if a user has access to a specific feature.
 *
 * Features can be explicitly granted/denied via ACL entries with resourceType "feature".
 * If no explicit entry exists, falls back to defaults based on the user's space permission level.
 *
 * @example
 * // Check if user can comment
 * const canComment = await hasFeature(spaceId, Feature.COMMENT, userId, userGroups);
 *
 * // Grant commenting to a specific group
 * await grantFeature(spaceId, Feature.COMMENT, undefined, "viewers");
 */
export async function hasFeature(
  spaceId: string,
  feature: Feature,
  userId: string,
  userGroups?: string[],
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  // Check for explicit feature ACL entry (user-specific)
  const userEntry = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, ResourceType.FEATURE),
        eq(acl.resourceId, feature),
        eq(acl.userId, userId),
        isNull(acl.groupId),
      ),
    )
    .get();

  if (userEntry) {
    return userEntry.permission !== "denied";
  }

  // Check for explicit feature ACL entry (group-based)
  const effectiveGroups = userGroups && userGroups.length > 0 ? userGroups : ["public"];
  const groupEntry = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, ResourceType.FEATURE),
        eq(acl.resourceId, feature),
        isNull(acl.userId),
        inArray(acl.groupId, effectiveGroups),
      ),
    )
    .get();

  if (groupEntry) {
    return groupEntry.permission !== "denied";
  }

  // Fall back to defaults based on space permission level
  const spacePerm = await getPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    userGroups,
  );
  if (!spacePerm) {
    return false;
  }

  const defaultFeatures = DEFAULT_FEATURES[spacePerm.permission] ?? [];
  return defaultFeatures.includes(feature);
}

/**
 * Grant a feature to a user or group.
 *
 * @example
 * // Grant commenting to a specific user
 * await grantFeature(spaceId, Feature.COMMENT, userId);
 *
 * // Grant history viewing to all viewers
 * await grantFeature(spaceId, Feature.VIEW_HISTORY, undefined, "viewers");
 */
export async function grantFeature(
  spaceId: string,
  feature: Feature,
  userId?: string,
  groupId?: string,
): Promise<AclEntry> {
  return grantPermission(
    spaceId,
    ResourceType.FEATURE,
    feature,
    userId,
    Permission.VIEWER,
    groupId,
  );
}

/**
 * Deny a feature from a user or group (explicit deny).
 *
 * @example
 * // Deny commenting for a specific user
 * await denyFeature(spaceId, Feature.COMMENT, userId);
 */
export async function denyFeature(
  spaceId: string,
  feature: Feature,
  userId?: string,
  groupId?: string,
): Promise<AclEntry> {
  return grantPermission(
    spaceId,
    ResourceType.FEATURE,
    feature,
    userId,
    "denied",
    groupId,
  );
}

/**
 * Remove explicit feature grant/deny (reverts to default behaviour).
 *
 * @example
 * await revokeFeature(spaceId, Feature.COMMENT, userId);
 */
export async function revokeFeature(
  spaceId: string,
  feature: Feature,
  userId?: string,
  groupId?: string,
): Promise<boolean> {
  return revokePermission(spaceId, ResourceType.FEATURE, feature, userId, groupId);
}

/**
 * List all feature permissions for a space.
 */
export async function listFeaturePermissions(spaceId: string): Promise<AclEntry[]> {
  const db = await getSpaceDb(spaceId);

  const results = await db
    .select()
    .from(acl)
    .where(eq(acl.resourceType, ResourceType.FEATURE))
    .all();

  return results.map((r) => ({
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    userId: r.userId || undefined,
    groupId: r.groupId || undefined,
    permission: r.permission,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  }));
}

export async function listAccessibleResources(
  spaceId: string,
  userId: string,
  resourceType: ResourceType,
  userGroups?: string[],
  minPermission?: string,
): Promise<string[]> {
  const db = await getSpaceDb(spaceId);

  const conditions = [eq(acl.userId, userId), eq(acl.resourceType, resourceType)];

  if (minPermission) {
    const minLevel = PERMISSION_HIERARCHY[minPermission] || 0;
    const validPermissions = Object.entries(PERMISSION_HIERARCHY)
      .filter(([_, level]) => level >= minLevel)
      .map(([perm]) => perm);

    conditions.push(inArray(acl.permission, validPermissions));
  }

  const results = await db
    .select({ resourceId: acl.resourceId })
    .from(acl)
    .where(and(...conditions))
    .all();

  // Also get group-based accessible resources
  if (userGroups && userGroups.length > 0) {
    const groupConditions = [
      isNull(acl.userId),
      inArray(acl.groupId, userGroups),
      eq(acl.resourceType, resourceType),
    ];

    if (minPermission) {
      const minLevel = PERMISSION_HIERARCHY[minPermission] || 0;
      const validPermissions = Object.entries(PERMISSION_HIERARCHY)
        .filter(([_, level]) => level >= minLevel)
        .map(([perm]) => perm);

      groupConditions.push(inArray(acl.permission, validPermissions));
    }

    const groupResults = await db
      .select({ resourceId: acl.resourceId })
      .from(acl)
      .where(and(...groupConditions))
      .all();

    results.push(...groupResults);
  }

  // Deduplicate resource IDs
  return [...new Set(results.map((r) => r.resourceId))];
}

export async function copyPermissions(
  spaceId: string,
  sourceResourceType: ResourceType,
  sourceResourceId: string,
  targetResourceType: ResourceType,
  targetResourceId: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  const sourcePermissions = await listPermissions(
    spaceId,
    sourceResourceType,
    sourceResourceId,
  );

  for (const perm of sourcePermissions) {
    await db.insert(acl).values({
      resourceType: targetResourceType,
      resourceId: targetResourceId,
      userId: perm.userId,
      permission: perm.permission,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function bulkGrantPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userIds: string[],
  permission: string,
  groupIds?: string[],
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  const values: any[] = userIds.map((userId) => ({
    resourceType,
    resourceId,
    userId,
    groupId: null,
    permission,
    createdAt: now,
    updatedAt: now,
  }));

  if (groupIds && groupIds.length > 0) {
    const groupValues = groupIds.map((groupId) => ({
      resourceType,
      resourceId,
      userId: null,
      groupId,
      permission,
      createdAt: now,
      updatedAt: now,
    }));
    values.push(...groupValues);
  }

  for (const value of values) {
    await db
      .insert(acl)
      .values(value)
      .onConflictDoUpdate({
        target: [acl.resourceType, acl.resourceId, acl.userId, acl.groupId],
        set: {
          permission,
          updatedAt: now,
        },
      });
  }
}

export async function bulkRevokePermissions(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userIds?: string[],
  groupIds?: string[],
): Promise<void> {
  const db = await getSpaceDb(spaceId);

  if (userIds && userIds.length > 0) {
    await db
      .delete(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          eq(acl.resourceId, resourceId),
          inArray(acl.userId, userIds),
        ),
      );
  }

  if (groupIds && groupIds.length > 0) {
    await db
      .delete(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          eq(acl.resourceId, resourceId),
          inArray(acl.groupId, groupIds),
        ),
      );
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
  const db = await getSpaceDb(spaceId);
  const authDb = getAuthDb();

  const results = await db
    .select()
    .from(acl)
    .where(and(eq(acl.resourceType, ResourceType.SPACE), eq(acl.resourceId, spaceId)))
    .all();

  const memberIds = new Set<string>();
  const groupsToCheck: string[] = [];

  for (const entry of results) {
    if (entry.userId) {
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

    const groupMembers = await authDb
      .select({ id: user.id })
      .from(user)
      .where(or(...conditions))
      .all();

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
  const db = await getSpaceDb(spaceId);
  const authDb = getAuthDb();

  const results = await db
    .select()
    .from(acl)
    .where(and(eq(acl.resourceType, ResourceType.SPACE), eq(acl.resourceId, spaceId)))
    .all();

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

    const members = await authDb
      .select({ id: user.id, groups: user.groups })
      .from(user)
      .where(or(...conditions))
      .all();

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

/**
 * Make a document publicly accessible by granting viewer permission to the "public" group.
 *
 * Public access is always read-only for security reasons.
 *
 * @param spaceId - The space ID
 * @param documentId - The document ID to make public
 * @returns The created ACL entry
 *
 * @example
 * // Make document publicly readable
 * await makeDocumentPublic(spaceId, documentId);
 */
export async function makeDocumentPublic(
  spaceId: string,
  documentId: string,
): Promise<AclEntry> {
  return grantPermission(
    spaceId,
    ResourceType.DOCUMENT,
    documentId,
    undefined,
    Permission.VIEWER,
    "public",
  );
}

/**
 * Remove public access from a document.
 *
 * @param spaceId - The space ID
 * @param documentId - The document ID
 * @returns true if successful
 *
 * @example
 * await removePublicAccess(spaceId, documentId);
 */
export async function removePublicAccess(
  spaceId: string,
  documentId: string,
): Promise<boolean> {
  return revokePermission(
    spaceId,
    ResourceType.DOCUMENT,
    documentId,
    undefined,
    "public",
  );
}

/**
 * Check if a document is publicly accessible.
 *
 * @param spaceId - The space ID
 * @param documentId - The document ID
 * @returns true if document has public access
 *
 * @example
 * const isPublic = await isDocumentPublic(spaceId, documentId);
 * if (isPublic) {
 *   console.log("Document is publicly accessible");
 * }
 */
export async function isDocumentPublic(
  spaceId: string,
  documentId: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  const result = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, ResourceType.DOCUMENT),
        eq(acl.resourceId, documentId),
        eq(acl.groupId, "public"),
        isNull(acl.userId),
      ),
    )
    .get();

  return !!result;
}

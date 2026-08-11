import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import {
  type AclViewer,
  type Feature,
  GROUP_NAME_PATTERN,
  meetsPermissionLevel,
  Permission,
  PUBLIC_GROUP,
  permissionLevel,
  permissionsAtLeast,
  ResourceType,
  resolveFeature,
} from "#acl/permissions.ts";
import { createAuditLog } from "#db/auditLogs.ts";
import { getAuthDb, getSpaceDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";
import { acl, category, document, property } from "#db/schema/space.ts";
import { parseStoredPropertyValue, propertyValueToText } from "#documents/properties.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";

export interface AclEntry {
  resourceType: string;
  resourceId: string;
  userId?: string;
  groupId?: string;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
}

type AclRow = {
  resourceType: string;
  resourceId: string;
  userId: string | null;
  groupId: string | null;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function getUserGroups(userId: string): Promise<string[]> {
  const authDb = getAuthDb();
  if (!authDb) {
    return [PUBLIC_GROUP];
  }

  const userRecord = await authDb.select().from(user).where(eq(user.id, userId)).get();

  const groups = [PUBLIC_GROUP];

  if (userRecord?.groups) {
    try {
      const userGroups = JSON.parse(userRecord.groups);
      if (Array.isArray(userGroups)) {
        // Defense in depth: do not trust stored groups blindly — only
        // well-formed names enter the authorization group set.
        groups.push(
          ...userGroups.filter(
            (g): g is string => typeof g === "string" && GROUP_NAME_PATTERN.test(g),
          ),
        );
      }
    } catch {
      // Keep just "public"
    }
  }

  return groups;
}

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

  const rows = await authDb
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      groups: user.groups,
    })
    .from(user)
    .where(or(...conditions))
    .all();

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
      .map(({ id, name, email, image }) => ({ id, name, email, image }))
  );
}

/**
 * Display name of a grantee, captured when the permission change is logged so
 * the audit entry stays readable after the account is renamed or removed.
 */
async function resolveGranteeName(userId?: string): Promise<string | undefined> {
  if (!userId) return undefined;
  const authDb = getAuthDb();
  if (!authDb) return undefined;
  try {
    const record = await authDb
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    return record?.name || record?.email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write an acl_grant / acl_revoke entry for a permission change.
 *
 * Document-scoped changes are logged against the document so they show up in
 * that document's activity; everything else (space membership, categories,
 * feature overrides) is logged against the space.
 */
async function logAclChange(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  spaceId: string,
  params: {
    event: "acl_grant" | "acl_revoke";
    resourceType: ResourceType;
    resourceId: string;
    userId?: string;
    groupId?: string;
    permission?: string;
    previousPermission?: string;
    actorUserId?: string;
  },
): Promise<void> {
  const isDocumentScoped =
    params.resourceType === ResourceType.DOCUMENT ||
    params.resourceType === ResourceType.DOCUMENT_TREE;
  const targetName = await resolveGranteeName(params.userId);
  const target = params.userId
    ? `user ${targetName ?? params.userId}`
    : `group ${params.groupId}`;
  const scope =
    params.resourceType === ResourceType.SPACE
      ? "the space"
      : `${params.resourceType} ${params.resourceId}`;

  await createAuditLog(db, {
    spaceId,
    docId: isDocumentScoped ? params.resourceId : spaceId,
    userId: params.actorUserId,
    event: params.event,
    details: {
      message:
        params.event === "acl_grant"
          ? `Granted ${params.permission} permission on ${scope} to ${target}`
          : `Revoked permission on ${scope} from ${target}`,
      permission: params.permission,
      previousValue: params.previousPermission,
      targetUserId: params.userId,
      targetGroupId: params.groupId,
      targetName,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
    },
  });
}

export async function grantPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string | undefined,
  permission: string,
  groupId?: string,
  actorUserId?: string,
): Promise<AclEntry> {
  if (!userId && !groupId) {
    throw new Error("Either userId or groupId must be provided");
  }

  if (groupId && !GROUP_NAME_PATTERN.test(groupId)) {
    throw new Error("Invalid group name");
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

  // Re-granting the same permission is a no-op; only log real changes.
  if (existing?.permission !== permission) {
    await logAclChange(db, spaceId, {
      event: "acl_grant",
      resourceType,
      resourceId,
      userId,
      groupId,
      permission,
      previousPermission: existing?.permission,
      actorUserId,
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
  actorUserId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  const conditions = [eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId)];

  if (userId) {
    conditions.push(eq(acl.userId, userId));
  }
  if (groupId) {
    conditions.push(eq(acl.groupId, groupId));
  }

  // Read first so the audit entry can record what was actually removed, and
  // so revoking a permission that does not exist does not log anything.
  const removed = await db
    .select()
    .from(acl)
    .where(and(...conditions))
    .all();

  await db.delete(acl).where(and(...conditions));

  for (const entry of removed) {
    await logAclChange(db, spaceId, {
      event: "acl_revoke",
      resourceType,
      resourceId,
      userId: entry.userId ?? undefined,
      groupId: entry.groupId ?? undefined,
      previousPermission: entry.permission,
      actorUserId,
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
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];

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
    const levelA = permissionLevel(a.permission);
    const levelB = permissionLevel(b.permission);
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

function bestAclEntry(rows: Array<AclRow | AclEntry>): AclEntry | null {
  if (rows.length === 0) return null;

  const result = rows.sort((a, b) => {
    const levelA = permissionLevel(a.permission);
    const levelB = permissionLevel(b.permission);
    return levelB - levelA;
  })[0];

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

async function getBestPermissionForResourceIds(
  spaceId: string,
  resourceType: ResourceType,
  resourceIds: string[],
  userId: string,
  userGroups?: string[],
): Promise<AclEntry | null> {
  if (resourceIds.length === 0) return null;

  const db = await getSpaceDb(spaceId);
  const allPermissions: AclRow[] = [];

  const userResults = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        inArray(acl.resourceId, resourceIds),
        eq(acl.userId, userId),
        isNull(acl.groupId),
      ),
    )
    .all();

  allPermissions.push(...userResults);

  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];
  const groupResults = await db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        inArray(acl.resourceId, resourceIds),
        isNull(acl.userId),
        inArray(acl.groupId, effectiveGroups),
      ),
    )
    .all();

  allPermissions.push(...groupResults);
  return bestAclEntry(allPermissions);
}

async function getDocumentAncestorIds(
  spaceId: string,
  documentId: string,
): Promise<string[]> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select({ id: document.id, parentId: document.parentId })
    .from(document)
    .all();

  const parentById = new Map(rows.map((row) => [row.id, row.parentId]));
  const ancestors: string[] = [];
  const seen = new Set<string>([documentId]);
  let current = parentById.get(documentId);

  while (current && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = parentById.get(current);
  }

  return ancestors;
}

async function getDocumentDescendantIds(
  spaceId: string,
  rootIds: string[],
): Promise<Set<string>> {
  const db = await getSpaceDb(spaceId);
  const roots = new Set(rootIds);
  const descendants = new Set(rootIds);
  if (rootIds.length === 0) return descendants;

  const rows = await db
    .select({ id: document.id, parentId: document.parentId })
    .from(document)
    .all();

  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const children = childrenByParent.get(row.parentId) ?? [];
    children.push(row.id);
    childrenByParent.set(row.parentId, children);
  }

  const stack = Array.from(roots);
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      stack.push(childId);
    }
  }

  return descendants;
}

async function getDocumentCategoryResourceIds(
  spaceId: string,
  documentId: string,
): Promise<string[]> {
  const db = await getSpaceDb(spaceId);
  const documentIds = [
    documentId,
    ...(await getDocumentAncestorIds(spaceId, documentId)),
  ];
  const categoryProperties = await db
    .select({ value: property.value })
    .from(property)
    .where(
      and(
        inArray(property.documentId, documentIds),
        inArray(property.key, ["category", "collection"]),
      ),
    )
    .all();

  const slugs = [...new Set(categoryProperties.map((row) => row.value).filter(Boolean))];
  if (slugs.length === 0) return [];

  const categoryRows = await db
    .select({ id: category.id })
    .from(category)
    .where(inArray(category.slug, slugs))
    .all();

  return categoryRows.map((row) => row.id);
}

async function getDocumentIdsForCategoryRoots(
  spaceId: string,
  categoryIds: string[],
): Promise<Set<string>> {
  const db = await getSpaceDb(spaceId);
  const ids = new Set<string>();
  if (categoryIds.length === 0) return ids;

  const categories = await db
    .select({ slug: category.slug })
    .from(category)
    .where(inArray(category.id, categoryIds))
    .all();
  const slugs = categories.map((row) => row.slug);
  if (slugs.length === 0) return ids;

  const directRows = await db
    .select({ documentId: property.documentId })
    .from(property)
    .where(
      and(
        inArray(property.key, ["category", "collection"]),
        inArray(property.value, slugs),
      ),
    )
    .all();

  const rootIds = directRows.map((row) => row.documentId);
  const descendantIds = await getDocumentDescendantIds(spaceId, rootIds);
  for (const id of descendantIds) ids.add(id);
  return ids;
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

/** One grant that reaches a document, and how it gets there. */
export interface DocumentAccessGrant {
  resourceType: string;
  resourceId: string;
  /** The grant is on an ancestor page, a category, or the space — not this page. */
  inherited: boolean;
  /** Page title or category name of the resource the grant sits on. */
  resourceLabel?: string;
  permission: string;
  createdAt: Date;
}

/** One grantee's effective access to a document. */
export interface DocumentAccessEntry {
  userId?: string;
  groupId?: string;
  /** Effective role on the document, resolved as `hasPermission` resolves it. */
  permission: string;
  /** The grant that decides `permission`. */
  via: DocumentAccessGrant;
  grants: DocumentAccessGrant[];
}

/**
 * Everyone who can reach a document, with the grant that gets them there.
 *
 * Mirrors the document branch of `hasPermission`: a direct, tree (this page or
 * any ancestor) or category grant decides the role, and only a grantee with
 * none of those falls back to their space role.
 */
export async function listDocumentAccess(
  spaceId: string,
  documentId: string,
): Promise<DocumentAccessEntry[]> {
  const db = await getSpaceDb(spaceId);

  const treeIds = [documentId, ...(await getDocumentAncestorIds(spaceId, documentId))];
  const categoryIds = await getDocumentCategoryResourceIds(spaceId, documentId);

  const scopes = [
    and(eq(acl.resourceType, ResourceType.DOCUMENT), eq(acl.resourceId, documentId)),
    and(
      eq(acl.resourceType, ResourceType.DOCUMENT_TREE),
      inArray(acl.resourceId, treeIds),
    ),
    and(eq(acl.resourceType, ResourceType.SPACE), eq(acl.resourceId, spaceId)),
  ];
  if (categoryIds.length > 0) {
    scopes.push(
      and(
        eq(acl.resourceType, ResourceType.CATEGORY),
        inArray(acl.resourceId, categoryIds),
      ),
    );
  }

  const rows = await db
    .select()
    .from(acl)
    .where(or(...scopes))
    .all();

  const labels = await getAclResourceLabels(spaceId, rows);

  const grantees = new Map<
    string,
    { userId?: string; groupId?: string; grants: DocumentAccessGrant[] }
  >();
  for (const row of rows) {
    const grantee = row.userId
      ? { key: `user:${row.userId}`, userId: row.userId }
      : row.groupId
        ? { key: `group:${row.groupId}`, groupId: row.groupId }
        : undefined;
    if (!grantee) continue;

    const existing = grantees.get(grantee.key) ?? { ...grantee, grants: [] };
    existing.grants.push({
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      inherited: row.resourceId !== documentId,
      resourceLabel: labels.get(`${row.resourceType}:${row.resourceId}`),
      permission: row.permission,
      createdAt: new Date(row.createdAt),
    });
    grantees.set(grantee.key, existing);
  }

  return [...grantees.values()].map(({ userId, groupId, grants }) => {
    // A grant on the document, its tree or its category overrides the space
    // role — even a lower one — so the space grant only counts on its own.
    const scoped = grants.filter((grant) => grant.resourceType !== ResourceType.SPACE);
    const via = bestGrant(scoped.length > 0 ? scoped : grants);
    return { userId, groupId, permission: via.permission, via, grants };
  });
}

function bestGrant(grants: DocumentAccessGrant[]): DocumentAccessGrant {
  return grants.reduce((best, grant) =>
    permissionLevel(grant.permission) > permissionLevel(best.permission) ? grant : best,
  );
}

/** Page titles and category names for the resources these grants sit on. */
async function getAclResourceLabels(
  spaceId: string,
  rows: Array<{ resourceType: string; resourceId: string }>,
): Promise<Map<string, string>> {
  const db = await getSpaceDb(spaceId);
  const labels = new Map<string, string>();

  const documentIds = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.resourceType === ResourceType.DOCUMENT ||
            row.resourceType === ResourceType.DOCUMENT_TREE,
        )
        .map((row) => row.resourceId),
    ),
  ];
  const categoryIds = [
    ...new Set(
      rows
        .filter((row) => row.resourceType === ResourceType.CATEGORY)
        .map((row) => row.resourceId),
    ),
  ];

  if (documentIds.length > 0) {
    const titles = await db
      .select({ documentId: property.documentId, value: property.value })
      .from(property)
      .where(and(inArray(property.documentId, documentIds), eq(property.key, "title")))
      .all();
    const slugs = await db
      .select({ id: document.id, slug: document.slug })
      .from(document)
      .where(inArray(document.id, documentIds))
      .all();

    const titleById = new Map(
      titles.map((row) => [
        row.documentId,
        propertyValueToText(parseStoredPropertyValue(row.value)),
      ]),
    );
    for (const row of slugs) {
      const label = titleById.get(row.id) || row.slug;
      labels.set(`${ResourceType.DOCUMENT}:${row.id}`, label);
      labels.set(`${ResourceType.DOCUMENT_TREE}:${row.id}`, label);
    }
  }

  if (categoryIds.length > 0) {
    const categories = await db
      .select({ id: category.id, name: category.name })
      .from(category)
      .where(inArray(category.id, categoryIds))
      .all();
    for (const row of categories) {
      labels.set(`${ResourceType.CATEGORY}:${row.id}`, row.name);
    }
  }

  return labels;
}

/** List every role grant in a space, including resource-scoped grants. */
export async function listAllRolePermissions(spaceId: string): Promise<AclEntry[]> {
  const db = await getSpaceDb(spaceId);
  const results = await db.select().from(acl).all();

  return results
    .filter((row) => row.resourceType !== ResourceType.FEATURE)
    .map((row) => ({
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      userId: row.userId || undefined,
      groupId: row.groupId || undefined,
      permission: row.permission,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
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

/**
 * Whether the user (directly or via group) holds any ACL grant scoped to a
 * document, document tree, or category within this space. Used to make a
 * space visible/viewable to members who only have resource-scoped access,
 * without granting them any space-wide permission.
 */
export async function hasAnyResourceScopedAccess(
  spaceId: string,
  userId: string,
  userGroups?: string[],
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  const resourceTypeCondition = inArray(acl.resourceType, [
    ResourceType.DOCUMENT,
    ResourceType.DOCUMENT_TREE,
    ResourceType.CATEGORY,
  ]);

  const granteeConditions = [eq(acl.userId, userId)];
  if (userGroups && userGroups.length > 0) {
    granteeConditions.push(and(isNull(acl.userId), inArray(acl.groupId, userGroups))!);
  }

  const row = await db
    .select({ resourceId: acl.resourceId })
    .from(acl)
    .where(and(resourceTypeCondition, or(...granteeConditions)))
    .limit(1)
    .get();

  return !!row;
}

export async function hasPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  requiredPermission: Permission,
  userGroups?: string[],
): Promise<boolean> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return true;
  }

  if (resourceType === ResourceType.DOCUMENT) {
    const directPermission = await getPermission(
      spaceId,
      ResourceType.DOCUMENT,
      resourceId,
      userId,
      userGroups,
    );

    const treeResourceIds = [
      resourceId,
      ...(await getDocumentAncestorIds(spaceId, resourceId)),
    ];
    const treePermission = await getBestPermissionForResourceIds(
      spaceId,
      ResourceType.DOCUMENT_TREE,
      treeResourceIds,
      userId,
      userGroups,
    );
    const categoryPermission = await getBestPermissionForResourceIds(
      spaceId,
      ResourceType.CATEGORY,
      await getDocumentCategoryResourceIds(spaceId, resourceId),
      userId,
      userGroups,
    );

    const documentPermission = bestAclEntry(
      [directPermission, treePermission, categoryPermission].filter(
        (entry): entry is AclEntry => !!entry,
      ),
    );

    if (documentPermission) {
      return meetsPermissionLevel(documentPermission.permission, requiredPermission);
    }

    const spacePermission = await getPermission(
      spaceId,
      ResourceType.SPACE,
      spaceId,
      userId,
      userGroups,
    );

    return !!(
      spacePermission &&
      meetsPermissionLevel(spacePermission.permission, requiredPermission)
    );
  }

  const userPermission = await getPermission(
    spaceId,
    resourceType,
    resourceId,
    userId,
    userGroups,
  );

  if (!userPermission) {
    // Extensions fall back to space-level permission.
    if (resourceType === ResourceType.EXTENSION) {
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
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return true;
  }

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
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];
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
  return resolveFeature(spacePerm?.permission, feature);
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
  actorUserId?: string,
): Promise<AclEntry> {
  return grantPermission(
    spaceId,
    ResourceType.FEATURE,
    feature,
    userId,
    Permission.VIEWER,
    groupId,
    actorUserId,
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
  actorUserId?: string,
): Promise<AclEntry> {
  return grantPermission(
    spaceId,
    ResourceType.FEATURE,
    feature,
    userId,
    "denied",
    groupId,
    actorUserId,
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
  actorUserId?: string,
): Promise<boolean> {
  return revokePermission(
    spaceId,
    ResourceType.FEATURE,
    feature,
    userId,
    groupId,
    actorUserId,
  );
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
  minPermission?: Permission,
): Promise<string[] | null> {
  const db = await getSpaceDb(spaceId);
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : await getUserGroups(userId);
  const validPermissions = minPermission ? permissionsAtLeast(minPermission) : null;

  // Space-level permission implies access to all resources in the space that
  // have no per-resource ACL restrictions (same fallback as hasPermission()).
  // Return null to signal "all accessible" — callers treat null like a job token.
  const spacePerm = await getPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    effectiveGroups,
  );
  if (spacePerm) {
    return null;
  }

  const conditions = [eq(acl.userId, userId), eq(acl.resourceType, resourceType)];

  if (validPermissions) {
    conditions.push(inArray(acl.permission, validPermissions));
  }

  const results = await db
    .select({ resourceId: acl.resourceId })
    .from(acl)
    .where(and(...conditions))
    .all();

  // Also get group-based accessible resources
  if (effectiveGroups.length > 0) {
    const groupConditions = [
      isNull(acl.userId),
      inArray(acl.groupId, effectiveGroups),
      eq(acl.resourceType, resourceType),
    ];

    if (validPermissions) {
      groupConditions.push(inArray(acl.permission, validPermissions));
    }

    const groupResults = await db
      .select({ resourceId: acl.resourceId })
      .from(acl)
      .where(and(...groupConditions))
      .all();

    results.push(...groupResults);
  }

  if (resourceType === ResourceType.DOCUMENT) {
    const treeConditions = [
      eq(acl.resourceType, ResourceType.DOCUMENT_TREE),
      or(
        and(eq(acl.userId, userId), isNull(acl.groupId)),
        and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
      ),
    ];

    if (validPermissions) {
      treeConditions.push(inArray(acl.permission, validPermissions));
    }

    const treeRoots = await db
      .select({ resourceId: acl.resourceId })
      .from(acl)
      .where(and(...treeConditions))
      .all();

    const descendantIds = await getDocumentDescendantIds(
      spaceId,
      treeRoots.map((row) => row.resourceId),
    );

    results.push(...Array.from(descendantIds).map((resourceId) => ({ resourceId })));
  }

  if (resourceType === ResourceType.DOCUMENT) {
    const categoryConditions = [
      eq(acl.resourceType, ResourceType.CATEGORY),
      or(
        and(eq(acl.userId, userId), isNull(acl.groupId)),
        and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
      ),
    ];

    if (validPermissions) {
      categoryConditions.push(inArray(acl.permission, validPermissions));
    }

    const categoryRoots = await db
      .select({ resourceId: acl.resourceId })
      .from(acl)
      .where(and(...categoryConditions))
      .all();

    const categoryDocumentIds = await getDocumentIdsForCategoryRoots(
      spaceId,
      categoryRoots.map((row) => row.resourceId),
    );

    results.push(
      ...Array.from(categoryDocumentIds).map((resourceId) => ({ resourceId })),
    );
  }

  // Deduplicate resource IDs
  return [...new Set(results.map((r) => r.resourceId))];
}

/**
 * Filter `resourceIds` down to those the user can read, mirroring
 * `hasPermission` semantics in bulk (one query instead of N):
 *  - a resource with NO ACL row applicable to the user falls back to the
 *    caller's space-level role — callers must have already verified the user
 *    holds at least `viewer` on the space;
 *  - a resource WITH applicable rows is readable only when the best of those
 *    rows is at least `viewer` (so explicit "denied"-style entries hide it);
 *  - a viewer carrying a `documentScope` holds no space-wide role, so that
 *    fallback would grant them everything: the scope is an allowlist and
 *    nothing outside it is readable.
 */
export async function filterReadableResources(
  spaceId: string,
  resourceType: ResourceType,
  resourceIds: string[],
  viewer: AclViewer,
): Promise<Set<string>> {
  const { userId, userGroups } = viewer;
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return new Set(resourceIds);
  }

  const scope =
    resourceType === ResourceType.DOCUMENT && viewer.documentScope
      ? new Set(viewer.documentScope)
      : null;

  const db = await getSpaceDb(spaceId);
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];

  const rows = await db
    .select({ resourceId: acl.resourceId, permission: acl.permission })
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        or(
          and(eq(acl.userId, userId), isNull(acl.groupId)),
          and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
        ),
      ),
    )
    .all();

  const bestLevel = new Map<string, number>();
  for (const row of rows) {
    const level = permissionLevel(row.permission);
    const previous = bestLevel.get(row.resourceId);
    if (previous === undefined || level > previous) {
      bestLevel.set(row.resourceId, level);
    }
  }

  let parentById: Map<string, string | null> | null = null;
  let treeBestLevel: Map<string, number> | null = null;
  let categoryDocumentBestLevel: Map<string, number> | null = null;

  if (resourceType === ResourceType.DOCUMENT) {
    const treeRows = await db
      .select({ resourceId: acl.resourceId, permission: acl.permission })
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, ResourceType.DOCUMENT_TREE),
          or(
            and(eq(acl.userId, userId), isNull(acl.groupId)),
            and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
          ),
        ),
      )
      .all();

    treeBestLevel = new Map<string, number>();
    for (const row of treeRows) {
      const level = permissionLevel(row.permission);
      const previous = treeBestLevel.get(row.resourceId);
      if (previous === undefined || level > previous) {
        treeBestLevel.set(row.resourceId, level);
      }
    }

    const docRows = await db
      .select({ id: document.id, parentId: document.parentId })
      .from(document)
      .all();
    parentById = new Map(docRows.map((row) => [row.id, row.parentId]));

    const categoryRows = await db
      .select({ resourceId: acl.resourceId, permission: acl.permission })
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, ResourceType.CATEGORY),
          or(
            and(eq(acl.userId, userId), isNull(acl.groupId)),
            and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
          ),
        ),
      )
      .all();

    // Expanded per permission level rather than per grant: the expansion walks
    // the category tree and every document's properties, and only the level a
    // root was granted at matters to the result. That is at most one walk per
    // level in the hierarchy instead of one per grant.
    const rootsByLevel = new Map<number, string[]>();
    for (const row of categoryRows) {
      const level = permissionLevel(row.permission);
      const roots = rootsByLevel.get(level) ?? [];
      roots.push(row.resourceId);
      rootsByLevel.set(level, roots);
    }

    categoryDocumentBestLevel = new Map<string, number>();
    for (const [level, roots] of rootsByLevel) {
      const categoryDocumentIds = await getDocumentIdsForCategoryRoots(spaceId, roots);
      for (const documentId of categoryDocumentIds) {
        const previous = categoryDocumentBestLevel.get(documentId);
        if (previous === undefined || level > previous) {
          categoryDocumentBestLevel.set(documentId, level);
        }
      }
    }
  }

  const readable = new Set<string>();
  for (const id of resourceIds) {
    if (scope && !scope.has(id)) continue;
    let level = bestLevel.get(id);

    if (parentById && treeBestLevel) {
      const seen = new Set<string>();
      let current: string | null | undefined = id;
      while (current && !seen.has(current)) {
        seen.add(current);
        const treeLevel = treeBestLevel.get(current);
        if (treeLevel !== undefined && (level === undefined || treeLevel > level)) {
          level = treeLevel;
        }
        current = parentById.get(current);
      }
    }

    const categoryLevel = categoryDocumentBestLevel?.get(id);
    if (categoryLevel !== undefined && (level === undefined || categoryLevel > level)) {
      level = categoryLevel;
    }

    if (level === undefined || level >= permissionLevel(Permission.VIEWER)) {
      readable.add(id);
    }
  }
  return readable;
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
 * Direct (non-group) userIds granted access to a document, document tree, or
 * category in this space. Used to resolve display names for members-table
 * rows that only hold a resource-scoped grant — they wouldn't otherwise
 * appear anywhere `getSpaceMembersWithGroups` (space-level only) looks.
 */
export async function getResourceScopedGranteeUserIds(
  spaceId: string,
): Promise<Set<string>> {
  const db = await getSpaceDb(spaceId);

  const rows = await db
    .selectDistinct({ userId: acl.userId })
    .from(acl)
    .where(
      and(
        inArray(acl.resourceType, [
          ResourceType.DOCUMENT,
          ResourceType.DOCUMENT_TREE,
          ResourceType.CATEGORY,
        ]),
        isNull(acl.groupId),
      ),
    )
    .all();

  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) userIds.add(row.userId);
  }
  return userIds;
}

import { and, eq, gt, inArray, isNotNull, isNull, like, or } from "drizzle-orm";
import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import {
  type AclViewer,
  type Feature,
  GROUP_NAME_PATTERN,
  isPermission,
  meetsPermissionLevel,
  Permission,
  PUBLIC_GROUP,
  permissionLevel,
  permissionsAtLeast,
  ResourceType,
  resolveFeature,
  strongestGrant,
  weakerPermission,
} from "#acl/permissions.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { getAuthDb } from "#db/client/db.ts";
import { many, one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import { acl, category, document, property } from "#db/schema/space.ts";
import { createAuditLog } from "#db/space/auditLogs.ts";
import { parseStoredPropertyValue, propertyValueToText } from "#documents/properties.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";
import { resolveProfileImage } from "#utils/gravatar.ts";

export interface AclEntry {
  resourceType: string;
  resourceId: string;
  userId?: string;
  groupId?: string;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Which credential the grant carries, null on an ordinary one. Carried out to
   * every caller so telling a credential from a person never needs its id.
   */
  kind?: string | null;
}

type AclRow = {
  resourceType: string;
  resourceId: string;
  userId: string | null;
  groupId: string | null;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
  /** Set only on a credential row: the issuer whose access bounds this grant. */
  createdBy?: string | null;
  /** Set only on a credential row: which credential it carries. */
  kind?: string | null;
};

/** An `acl` row as every caller outside the store sees it. */
function toAclEntry(row: AclRow): AclEntry {
  return {
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    userId: row.userId || undefined,
    groupId: row.groupId || undefined,
    permission: row.permission,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    kind: row.kind ?? null,
  };
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
async function resolveGranteeName(userId?: string): Promise<string | undefined> {
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

/**
 * Write an acl_grant / acl_revoke entry for a permission change.
 *
 * Document-scoped changes are logged against the document so they show up in
 * that document's activity; everything else (space membership, categories,
 * feature overrides) is logged against the space.
 *
 * Exported because access tokens write their own `acl` rows (they carry
 * credential columns `grantPermission` knows nothing about) and still have to
 * land in the same audit trail as every other grant.
 */
export async function logAclChange(
  store: SpaceStore,
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
    /** The row's {@link AclKind}, when the grant carries a credential. */
    kind?: string | null;
  },
): Promise<void> {
  const isDocumentScoped =
    params.resourceType === ResourceType.DOCUMENT ||
    params.resourceType === ResourceType.DOCUMENT_TREE;
  // A credential has no row in the user table, so don't look one up. Nor has a
  // principal whose account is gone: an id that resolves to no name is printed
  // bare rather than called a user on the strength of its shape.
  const targetName = params.kind ? undefined : await resolveGranteeName(params.userId);
  const target = params.kind
    ? `credential ${params.userId}`
    : params.userId
      ? targetName
        ? `user ${targetName}`
        : params.userId
      : `group ${params.groupId}`;
  const scope =
    params.resourceType === ResourceType.SPACE
      ? "the space"
      : `${params.resourceType} ${params.resourceId}`;

  await createAuditLog(store, {
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
  store: SpaceStore,
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

  const { db, spaceId } = store;
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

  const existing = await one(
    db
      .select()
      .from(acl)
      .where(and(...conditions)),
  );

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
    await logAclChange(store, spaceId, {
      event: "acl_grant",
      kind: existing?.kind,
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
  store: SpaceStore,
  resourceType: ResourceType,
  resourceId: string,
  userId?: string,
  groupId?: string,
  actorUserId?: string,
): Promise<boolean> {
  const { db, spaceId } = store;

  const conditions = [eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId)];

  if (userId) {
    conditions.push(eq(acl.userId, userId));
  }
  if (groupId) {
    conditions.push(eq(acl.groupId, groupId));
  }

  // Read first so the audit entry can record what was actually removed, and
  // so revoking a permission that does not exist does not log anything.
  const removed = await many(
    db
      .select()
      .from(acl)
      .where(and(...conditions)),
  );

  await db.delete(acl).where(and(...conditions));

  for (const entry of removed) {
    await logAclChange(store, spaceId, {
      event: "acl_revoke",
      kind: entry.kind,
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

/**
 * A revoked or expired grant keeps its row but stops authorizing; every read of
 * `acl` carries this. A function, so `now` is the request's and not the boot's.
 */
function live() {
  return and(
    isNull(acl.revokedAt),
    or(isNull(acl.expiresAt), gt(acl.expiresAt, new Date())),
  );
}

interface TokenIssuer {
  id: string;
  groups: string[];
}

/**
 * The user a credential acts for, or null when this principal is not one. Asks
 * for the row that carries a credential under this id — `kind` is what makes it
 * one, and a person's id simply matches nothing.
 */
async function tokenIssuer(
  spaceId: string,
  principalId: string,
): Promise<TokenIssuer | null> {
  const { db } = await openSpaceStore(spaceId);
  const row = await one(
    db
      .select({ createdBy: acl.createdBy, kind: acl.kind })
      .from(acl)
      .where(and(eq(acl.userId, principalId), isNotNull(acl.kind))),
  );

  if (!row?.createdBy) return null;
  return { id: row.createdBy, groups: await getUserGroups(row.createdBy) };
}

/**
 * What the issuer may currently do where a token grant on this resource sits:
 * documents by their access to that document, the rest by their space role.
 */
async function issuerRole(
  spaceId: string,
  issuer: TokenIssuer,
  resourceType: ResourceType,
  resourceId: string,
): Promise<string | undefined> {
  const entry =
    resourceType === ResourceType.DOCUMENT
      ? await getDocumentPermission(spaceId, resourceId, issuer.id, issuer.groups)
      : await getPermission(
          spaceId,
          ResourceType.SPACE,
          spaceId,
          issuer.id,
          issuer.groups,
        );

  return entry?.permission;
}

/**
 * Cap a token row at what its issuer holds today, so a demotion takes the tokens
 * that issuer minted down with it. `createdBy` is what marks a row as delegated;
 * an ordinary grant, including one reached through a group, passes untouched.
 */
async function capRowsToIssuer<T extends AclRow>(
  spaceId: string,
  resourceType: ResourceType,
  rows: T[],
): Promise<T[]> {
  if (!rows.some((row) => row.createdBy)) return rows;

  // Resolving an issuer is expensive — group lookup plus, for a document, a full
  // permission resolution over its ancestors. Rows commonly share an issuer, and
  // outside DOCUMENT the answer does not depend on the resource at all, so hold
  // both for the length of the call.
  const groupsByIssuer = new Map<string, string[]>();
  const roleByKey = new Map<string, string | undefined>();

  const capped: T[] = [];
  for (const row of rows) {
    if (!row.createdBy || !isPermission(row.permission)) {
      capped.push(row);
      continue;
    }

    let groups = groupsByIssuer.get(row.createdBy);
    if (!groups) {
      groups = await getUserGroups(row.createdBy);
      groupsByIssuer.set(row.createdBy, groups);
    }

    const key =
      resourceType === ResourceType.DOCUMENT
        ? `${row.createdBy}\0${row.resourceId}`
        : row.createdBy;
    let cap: string | undefined;
    if (roleByKey.has(key)) {
      cap = roleByKey.get(key);
    } else {
      cap = await issuerRole(
        spaceId,
        { id: row.createdBy, groups },
        resourceType,
        row.resourceId,
      );
      roleByKey.set(key, cap);
    }

    // The issuer holds nothing here, so the grant delegates nothing.
    if (!isPermission(cap)) continue;

    capped.push({ ...row, permission: weakerPermission(row.permission, cap) });
  }

  return capped;
}

/** Intersect two resource scopes, where null means "unrestricted". */
function intersectScopes(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const allowed = new Set(b);
  return a.filter((id) => allowed.has(id));
}

export async function getPermission(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  userGroups?: string[],
): Promise<AclEntry | null> {
  const { db } = await openSpaceStore(spaceId);

  const allPermissions: AclRow[] = [];

  // Get user-specific permission
  const userResult = await one(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          eq(acl.resourceId, resourceId),
          eq(acl.userId, userId),
          isNull(acl.groupId),
          live(),
        ),
      ),
  );

  if (userResult) {
    allPermissions.push(userResult);
  }

  // Always include "public" in group checks to support public access
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];

  // Get group-based permissions (including "public")
  const groupResults = await many(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          eq(acl.resourceId, resourceId),
          isNull(acl.userId),
          inArray(acl.groupId, effectiveGroups),
          live(),
        ),
      ),
  );

  allPermissions.push(...groupResults);
  return bestAclEntry(await capRowsToIssuer(spaceId, resourceType, allPermissions));
}

/**
 * Whether a credential holds a row under this id in this space. For telling a
 * caller apart when it costs nothing to ask — a refusal, a log line — not for
 * deciding access, which reads `kind` off the row it already has.
 */
export async function isCredentialGrantee(
  spaceId: string,
  principalId: string,
): Promise<boolean> {
  const { db } = await openSpaceStore(spaceId);
  const row = await one(
    db
      .select({ kind: acl.kind })
      .from(acl)
      .where(and(eq(acl.userId, principalId), isNotNull(acl.kind))),
  );

  return row !== null && row !== undefined;
}

/** The strongest of these ACL rows, as an entry. Null when there are none. */
function bestAclEntry(rows: Array<AclRow | AclEntry>): AclEntry | null {
  const result = strongestGrant(rows, (row) => row.permission);
  if (!result) return null;

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

  const { db } = await openSpaceStore(spaceId);
  const allPermissions: AclRow[] = [];

  const userResults = await many(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          inArray(acl.resourceId, resourceIds),
          eq(acl.userId, userId),
          isNull(acl.groupId),
          live(),
        ),
      ),
  );

  allPermissions.push(...userResults);

  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];
  const groupResults = await many(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          inArray(acl.resourceId, resourceIds),
          isNull(acl.userId),
          inArray(acl.groupId, effectiveGroups),
          live(),
        ),
      ),
  );

  allPermissions.push(...groupResults);
  return bestAclEntry(await capRowsToIssuer(spaceId, resourceType, allPermissions));
}

async function getDocumentAncestorIds(
  spaceId: string,
  documentId: string,
): Promise<string[]> {
  const { db } = await openSpaceStore(spaceId);
  const rows = await many(
    db.select({ id: document.id, parentId: document.parentId }).from(document),
  );

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
  const { db } = await openSpaceStore(spaceId);
  const roots = new Set(rootIds);
  const descendants = new Set(rootIds);
  if (rootIds.length === 0) return descendants;

  const rows = await many(
    db.select({ id: document.id, parentId: document.parentId }).from(document),
  );

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
  const { db } = await openSpaceStore(spaceId);
  const documentIds = [
    documentId,
    ...(await getDocumentAncestorIds(spaceId, documentId)),
  ];
  const categoryProperties = await many(
    db
      .select({ value: property.value })
      .from(property)
      .where(
        and(
          inArray(property.documentId, documentIds),
          inArray(property.key, ["category", "collection"]),
        ),
      ),
  );

  const slugs = [...new Set(categoryProperties.map((row) => row.value).filter(Boolean))];
  if (slugs.length === 0) return [];

  const categoryRows = await many(
    db.select({ id: category.id }).from(category).where(inArray(category.slug, slugs)),
  );

  return categoryRows.map((row) => row.id);
}

async function getDocumentIdsForCategoryRoots(
  spaceId: string,
  categoryIds: string[],
): Promise<Set<string>> {
  const { db } = await openSpaceStore(spaceId);
  const ids = new Set<string>();
  if (categoryIds.length === 0) return ids;

  const categories = await many(
    db
      .select({ slug: category.slug })
      .from(category)
      .where(inArray(category.id, categoryIds)),
  );
  const slugs = categories.map((row) => row.slug);
  if (slugs.length === 0) return ids;

  const directRows = await many(
    db
      .select({ documentId: property.documentId })
      .from(property)
      .where(
        and(
          inArray(property.key, ["category", "collection"]),
          inArray(property.value, slugs),
        ),
      ),
  );

  const rootIds = directRows.map((row) => row.documentId);
  const descendantIds = await getDocumentDescendantIds(spaceId, rootIds);
  for (const id of descendantIds) ids.add(id);
  return ids;
}

export async function listPermissions(
  store: SpaceStore,
  resourceType: ResourceType,
  resourceId: string,
): Promise<AclEntry[]> {
  const { db } = store;

  const results = await many(
    db
      .select()
      .from(acl)
      .where(and(eq(acl.resourceType, resourceType), eq(acl.resourceId, resourceId))),
  );

  return results.map(toAclEntry);
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
  const { db } = await openSpaceStore(spaceId);

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

  const rows = await many(
    db
      .select()
      .from(acl)
      .where(or(...scopes)),
  );

  const labels = await getAclResourceLabels(spaceId, rows);

  const grantees = new Map<
    string,
    { userId?: string; groupId?: string; grants: DocumentAccessGrant[] }
  >();
  for (const row of rows) {
    // People and groups holding a role, and nothing else. A credential sits in
    // this table under its own id and would read as a person, and a feature —
    // or the legacy "extensions" pseudo-permission — is not a level of access
    // to report as one.
    if (row.kind || !isPermission(row.permission)) continue;

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
    // Mirrors hasPermission: the strongest grant wins, space role included, so
    // a narrower grant never reads as a downgrade of it.
    const via = strongestGrant(grants, (grant) => grant.permission) ?? grants[0];
    return { userId, groupId, permission: via.permission, via, grants };
  });
}

/** Page titles and category names for the resources these grants sit on. */
async function getAclResourceLabels(
  spaceId: string,
  rows: Array<{ resourceType: string; resourceId: string }>,
): Promise<Map<string, string>> {
  const { db } = await openSpaceStore(spaceId);
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
    const titles = await many(
      db
        .select({ documentId: property.documentId, value: property.value })
        .from(property)
        .where(and(inArray(property.documentId, documentIds), eq(property.key, "title"))),
    );
    const slugs = await many(
      db
        .select({ id: document.id, slug: document.slug })
        .from(document)
        .where(inArray(document.id, documentIds)),
    );

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
    const categories = await many(
      db
        .select({ id: category.id, name: category.name })
        .from(category)
        .where(inArray(category.id, categoryIds)),
    );
    for (const row of categories) {
      labels.set(`${ResourceType.CATEGORY}:${row.id}`, row.name);
    }
  }

  return labels;
}

/** List every role grant in a space, including resource-scoped grants. */
export async function listAllRolePermissions(store: SpaceStore): Promise<AclEntry[]> {
  const { db } = store;
  const results = await many(db.select().from(acl));

  return results
    .filter((row) => row.resourceType !== ResourceType.FEATURE)
    .map(toAclEntry);
}

export async function listUserPermissions(
  spaceId: string,
  userId: string,
  userGroups?: string[],
  resourceType?: ResourceType,
): Promise<AclEntry[]> {
  const { db } = await openSpaceStore(spaceId);

  const conditions = [eq(acl.userId, userId)];
  if (resourceType) {
    conditions.push(eq(acl.resourceType, resourceType));
  }

  const results = await many(
    db
      .select()
      .from(acl)
      .where(and(...conditions)),
  );

  // Also get group-based permissions
  if (userGroups && userGroups.length > 0) {
    const groupConditions = [isNull(acl.userId), inArray(acl.groupId, userGroups)];
    if (resourceType) {
      groupConditions.push(eq(acl.resourceType, resourceType));
    }

    const groupResults = await many(
      db
        .select()
        .from(acl)
        .where(and(...groupConditions)),
    );

    results.push(...groupResults);
  }

  return results.map(toAclEntry);
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
  const { db } = await openSpaceStore(spaceId);

  const resourceTypeCondition = inArray(acl.resourceType, [
    ResourceType.DOCUMENT,
    ResourceType.DOCUMENT_TREE,
    ResourceType.CATEGORY,
  ]);

  const granteeConditions = [eq(acl.userId, userId)];
  if (userGroups && userGroups.length > 0) {
    granteeConditions.push(and(isNull(acl.userId), inArray(acl.groupId, userGroups))!);
  }

  const row = await one(
    db
      .select({ resourceType: acl.resourceType, resourceId: acl.resourceId })
      .from(acl)
      .where(and(resourceTypeCondition, live(), or(...granteeConditions)))
      .limit(1),
  );

  if (!row) return false;

  // A token reaches a space only as far as its issuer still does. The question
  // is whether the issuer can still reach the resource this token was granted
  // on — not whether the issuer happens to hold a resource-scoped grant of
  // their own. An owner holds a space row and no document row, and still
  // plainly outranks a document-scoped token they minted.
  const issuer = await tokenIssuer(spaceId, userId);
  if (issuer) {
    const cap = await issuerRole(
      spaceId,
      issuer,
      row.resourceType as ResourceType,
      row.resourceId,
    );
    return isPermission(cap);
  }

  return true;
}

/**
 * The role a user effectively holds on one document: the best of its direct,
 * tree, category and space grants. Grants add up so a narrow one cannot demote
 * someone — sharing a document as viewer would otherwise lock out its owner.
 */
export async function getDocumentPermission(
  spaceId: string,
  documentId: string,
  userId: string,
  userGroups?: string[],
): Promise<AclEntry | null> {
  const directPermission = await getPermission(
    spaceId,
    ResourceType.DOCUMENT,
    documentId,
    userId,
    userGroups,
  );

  const treeResourceIds = [
    documentId,
    ...(await getDocumentAncestorIds(spaceId, documentId)),
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
    await getDocumentCategoryResourceIds(spaceId, documentId),
    userId,
    userGroups,
  );

  const spacePermission = await getPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    userGroups,
  );

  return bestAclEntry(
    [directPermission, treePermission, categoryPermission, spacePermission].filter(
      (entry): entry is AclEntry => !!entry,
    ),
  );
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
    const documentPermission = await getDocumentPermission(
      spaceId,
      resourceId,
      userId,
      userGroups,
    );

    return !!(
      documentPermission &&
      meetsPermissionLevel(documentPermission.permission, requiredPermission)
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
    // Extensions and categories fall back to space-level permission, as
    // documents do through `getDocumentPermission`: a grant on the space
    // reaches what the space contains. Every principal, so a space-scoped
    // token and the `public` group reach a category at their own level —
    // never above it, since the space grant is still level-checked below.
    if (
      resourceType === ResourceType.EXTENSION ||
      resourceType === ResourceType.CATEGORY
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

/**
 * Check if a user has access to a specific feature.
 *
 * Features can be explicitly granted/denied via ACL entries with resourceType "feature".
 * If no explicit entry exists, falls back to defaults based on the user's space permission level.
 *
 * @param documentId Resolve the fallback against this document's role instead of
 *   the space role, since a document- or tree-level share carries no space role.
 *   The answer is then only meaningful for that document.
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
  documentId?: string,
): Promise<boolean> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return true;
  }

  // Features do not pass through `decideAccess`, so the instance-admin rule has
  // to be repeated here: an admin who can read a document but not its history
  // would only have to click "gain access" to get it, which makes the refusal
  // inconsistent rather than protective.
  if (await isInstanceAdmin(userId)) {
    return true;
  }

  // A token holds a feature only for as long as its issuer does.
  const issuer = await tokenIssuer(spaceId, userId);
  if (
    issuer &&
    !(await hasFeature(spaceId, feature, issuer.id, issuer.groups, documentId))
  ) {
    return false;
  }

  const { db } = await openSpaceStore(spaceId);

  // Check for explicit feature ACL entry (user-specific)
  const userEntry = await one(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, ResourceType.FEATURE),
          eq(acl.resourceId, feature),
          eq(acl.userId, userId),
          isNull(acl.groupId),
          live(),
        ),
      ),
  );

  if (userEntry) {
    return userEntry.permission !== "denied";
  }

  // Check for explicit feature ACL entry (group-based)
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];
  const groupEntry = await one(
    db
      .select()
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, ResourceType.FEATURE),
          eq(acl.resourceId, feature),
          isNull(acl.userId),
          inArray(acl.groupId, effectiveGroups),
          live(),
        ),
      ),
  );

  if (groupEntry) {
    return groupEntry.permission !== "denied";
  }

  // Fall back to defaults based on permission level
  const role = documentId
    ? await getDocumentPermission(spaceId, documentId, userId, userGroups)
    : await getPermission(spaceId, ResourceType.SPACE, spaceId, userId, userGroups);
  return resolveFeature(role?.permission, feature);
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
  const store = await openSpaceStore(spaceId);
  return grantPermission(
    store,
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
  const store = await openSpaceStore(spaceId);
  return grantPermission(
    store,
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
  const store = await openSpaceStore(spaceId);
  return revokePermission(
    store,
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
export async function listFeaturePermissions(store: SpaceStore): Promise<AclEntry[]> {
  const { db } = store;

  const results = await many(
    db.select().from(acl).where(eq(acl.resourceType, ResourceType.FEATURE)),
  );

  return results.map(toAclEntry);
}

/** As below, before a token's issuer is applied. */
async function resolveAccessibleResources(
  spaceId: string,
  userId: string,
  resourceType: ResourceType,
  userGroups?: string[],
  minPermission?: Permission,
): Promise<string[] | null> {
  // Same bypass as hasPermission(): the local user holds no ACL rows in a space
  // it did not create, and without this every such space reads as empty.
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return null;
  }

  const { db } = await openSpaceStore(spaceId);
  const resolvedGroups =
    userGroups && userGroups.length > 0 ? userGroups : await getUserGroups(userId);
  // Same rule as every other group query here: no groups resolves against the
  // public group, so a credential reaches world-readable resources in a listing
  // exactly as it does in a direct read.
  const effectiveGroups = resolvedGroups.length > 0 ? resolvedGroups : [PUBLIC_GROUP];
  const validPermissions = minPermission ? permissionsAtLeast(minPermission) : null;

  // Space-level permission implies access to all resources in the space that
  // have no per-resource ACL restrictions (same fallback as hasPermission()).
  // Return null to signal "all accessible" — callers treat null like a job token.
  //
  // Only when that role actually reaches `minPermission`, though: a viewer asked
  // for what they can edit reaches no resource space-wide, and answering
  // "unrestricted" would both over-report them and, for a token, erase the
  // issuer intersection that caps it in listAccessibleResources().
  const spacePerm = await getPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    effectiveGroups,
  );
  if (
    spacePerm &&
    (!minPermission || meetsPermissionLevel(spacePerm.permission, minPermission))
  ) {
    return null;
  }

  const conditions = [eq(acl.userId, userId), eq(acl.resourceType, resourceType), live()];

  if (validPermissions) {
    conditions.push(inArray(acl.permission, validPermissions));
  }

  const results = await many(
    db
      .select({ resourceId: acl.resourceId })
      .from(acl)
      .where(and(...conditions)),
  );

  // Also get group-based accessible resources
  if (effectiveGroups.length > 0) {
    const groupConditions = [
      isNull(acl.userId),
      inArray(acl.groupId, effectiveGroups),
      eq(acl.resourceType, resourceType),
      live(),
    ];

    if (validPermissions) {
      groupConditions.push(inArray(acl.permission, validPermissions));
    }

    const groupResults = await many(
      db
        .select({ resourceId: acl.resourceId })
        .from(acl)
        .where(and(...groupConditions)),
    );

    results.push(...groupResults);
  }

  if (resourceType === ResourceType.DOCUMENT) {
    const treeConditions = [
      eq(acl.resourceType, ResourceType.DOCUMENT_TREE),
      or(
        and(eq(acl.userId, userId), isNull(acl.groupId)),
        and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
      ),
      live(),
    ];

    if (validPermissions) {
      treeConditions.push(inArray(acl.permission, validPermissions));
    }

    const treeRoots = await many(
      db
        .select({ resourceId: acl.resourceId })
        .from(acl)
        .where(and(...treeConditions)),
    );

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
      live(),
    ];

    if (validPermissions) {
      categoryConditions.push(inArray(acl.permission, validPermissions));
    }

    const categoryRoots = await many(
      db
        .select({ resourceId: acl.resourceId })
        .from(acl)
        .where(and(...categoryConditions)),
    );

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
 * Resources this identity can reach at `minPermission`. Null means unrestricted.
 * A token reaches the intersection of its own scope and its issuer's.
 *
 * The intersection carries the level cap as well as the scope: a token's stored
 * permission is a ceiling, and its effective one is the weaker of that and the
 * issuer's. Since both passes filter at `minPermission`, a resource survives
 * only when token and issuer each reach it at that level — which is exactly
 * when the weaker of the two does.
 */
export async function listAccessibleResources(
  spaceId: string,
  userId: string,
  resourceType: ResourceType,
  userGroups?: string[],
  minPermission?: Permission,
): Promise<string[] | null> {
  const own = await resolveAccessibleResources(
    spaceId,
    userId,
    resourceType,
    userGroups,
    minPermission,
  );

  const issuer = await tokenIssuer(spaceId, userId);
  if (!issuer) return own;

  return intersectScopes(
    own,
    await resolveAccessibleResources(
      spaceId,
      issuer.id,
      resourceType,
      issuer.groups,
      minPermission,
    ),
  );
}

/**
 * Filter `resourceIds` down to those the user can read, mirroring
 * `hasPermission` semantics in bulk (one query instead of N):
 *  - a resource with NO ACL row applicable to the user falls back to the
 *    caller's space-level role — callers must have already verified the user
 *    holds at least `minPermission` on the space;
 *  - a resource WITH applicable rows is readable only when the best of those
 *    rows is at least `minPermission` (so explicit "denied"-style entries hide
 *    it);
 *  - a viewer carrying a `documentScope` holds no space-wide role, so that
 *    fallback would grant them everything: the scope is an allowlist and
 *    nothing outside it is readable.
 */
async function resolveReadableResources(
  spaceId: string,
  resourceType: ResourceType,
  resourceIds: string[],
  viewer: AclViewer,
  minPermission: Permission = Permission.VIEWER,
  /**
   * Whether a resource with no ACL row of its own falls back to the viewer's
   * space role. True for a caller who has already been verified to hold
   * `minPermission` on the space — which is every caller but the token pass
   * below, where the issuer is resolved here rather than at the route.
   */
  spaceFallback = true,
): Promise<Set<string>> {
  const { userId, userGroups } = viewer;
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return new Set(resourceIds);
  }

  const scope =
    resourceType === ResourceType.DOCUMENT && viewer.documentScope
      ? new Set(viewer.documentScope)
      : null;

  const { db } = await openSpaceStore(spaceId);
  const effectiveGroups =
    userGroups && userGroups.length > 0 ? userGroups : [PUBLIC_GROUP];

  const rows = await many(
    db
      .select({ resourceId: acl.resourceId, permission: acl.permission })
      .from(acl)
      .where(
        and(
          eq(acl.resourceType, resourceType),
          or(
            and(eq(acl.userId, userId), isNull(acl.groupId)),
            and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
          ),
          live(),
        ),
      ),
  );

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
    const treeRows = await many(
      db
        .select({ resourceId: acl.resourceId, permission: acl.permission })
        .from(acl)
        .where(
          and(
            eq(acl.resourceType, ResourceType.DOCUMENT_TREE),
            or(
              and(eq(acl.userId, userId), isNull(acl.groupId)),
              and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
            ),
            live(),
          ),
        ),
    );

    treeBestLevel = new Map<string, number>();
    for (const row of treeRows) {
      const level = permissionLevel(row.permission);
      const previous = treeBestLevel.get(row.resourceId);
      if (previous === undefined || level > previous) {
        treeBestLevel.set(row.resourceId, level);
      }
    }

    const docRows = await many(
      db.select({ id: document.id, parentId: document.parentId }).from(document),
    );
    parentById = new Map(docRows.map((row) => [row.id, row.parentId]));

    const categoryRows = await many(
      db
        .select({ resourceId: acl.resourceId, permission: acl.permission })
        .from(acl)
        .where(
          and(
            eq(acl.resourceType, ResourceType.CATEGORY),
            or(
              and(eq(acl.userId, userId), isNull(acl.groupId)),
              and(isNull(acl.userId), inArray(acl.groupId, effectiveGroups)),
            ),
            live(),
          ),
        ),
    );

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

    if (level === undefined ? spaceFallback : level >= permissionLevel(minPermission)) {
      readable.add(id);
    }
  }
  return readable;
}

/** As above, and for a token also passed through its issuer. */
export async function filterReadableResources(
  spaceId: string,
  resourceType: ResourceType,
  resourceIds: string[],
  viewer: AclViewer,
  minPermission: Permission = Permission.VIEWER,
): Promise<Set<string>> {
  const own = await resolveReadableResources(
    spaceId,
    resourceType,
    resourceIds,
    viewer,
    minPermission,
  );

  const issuer = await tokenIssuer(spaceId, viewer.userId);
  if (!issuer) return own;

  // Nothing verified the issuer's space role before this, so the fallback only
  // applies where it would have held: a resource with no row of its own is
  // theirs to read exactly when their space role already meets the bar.
  const issuerSpaceRole = await getPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    issuer.id,
    issuer.groups,
  );

  // Re-filtering `own` rather than intersecting keeps the result a subset.
  return resolveReadableResources(
    spaceId,
    resourceType,
    [...own],
    { userId: issuer.id, userGroups: issuer.groups },
    minPermission,
    meetsPermissionLevel(issuerSpaceRole?.permission, minPermission),
  );
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

/**
 * Direct (non-group) userIds granted access to a document, document tree, or
 * category in this space. Used to resolve display names for members-table
 * rows that only hold a resource-scoped grant — they wouldn't otherwise
 * appear anywhere `getSpaceMembersWithGroups` (space-level only) looks.
 */
export async function getResourceScopedGranteeUserIds(
  spaceId: string,
): Promise<Set<string>> {
  const { db } = await openSpaceStore(spaceId);

  const rows = await many(
    db
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
      ),
  );

  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) userIds.add(row.userId);
  }
  return userIds;
}

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import {
  highestPermission,
  Permission,
  PUBLIC_GROUP,
  ResourceType,
} from "#acl/permissions.ts";
import {
  countSpaceMembers,
  getUserGroups,
  grantPermission,
  hasAnyResourceScopedAccess,
  hasPermission,
  listUserPermissions,
} from "#acl/store.ts";
import {
  allocateSpaceDatabase,
  disableSpaceDatabase,
  getAssignedSpaceDatabase,
  getIndexedSpace,
  getIndexedSpaceBySlug,
  listIndexedSpaces,
  markSpaceDeleted,
  updateIndexedSpaceMetadata,
  upsertSpaceIndex,
} from "#db/auth/spaceIndex.ts";
import { resolveSpaceLocation } from "#db/client/connection.ts";
import {
  closeSpaceDb,
  createAllocatedSpaceDb,
  getSpaceDb,
  initializeDatabases,
} from "#db/client/db.ts";
import { many, one } from "#db/client/query.ts";
import { createId } from "#db/ids.ts";
import { preference, spaceMetadata } from "#db/schema/space.ts";
import { isInMemoryDb } from "#inMemoryDb";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";
import { slugify } from "#utils/utils.ts";

const DATA_DIR = "./data";
const DELETED_DIR = join(DATA_DIR, "deleted");
const UPLOADS_DIR = join(DATA_DIR, "uploads");

export interface Space {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  preferences: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  userRole?: string;
  memberCount?: number;
}

export async function createSpace(
  createdBy: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space> {
  const id = createId("space");
  const now = new Date();

  // Sanitize slug to contain only URL-compatible characters
  slug = slugify(slug);

  if (!slug) {
    throw new Error("Slug not valid");
  }

  // Check if slug already exists
  const existingSpace = await getSpaceBySlug(slug);
  if (existingSpace) {
    throw new Error(`Space with slug "${slug}" already exists`);
  }

  const allocation = await allocateSpaceDatabase(id);
  let spaceDb: Awaited<ReturnType<typeof getSpaceDb>>;
  const defaultPreferences = {
    brandColor: "#1e293b",
    [spacePreferenceKeys.workflowCreationEnabled]: "true",
    ...preferences,
  };

  try {
    spaceDb = await createAllocatedSpaceDb(id);
    await spaceDb.insert(spaceMetadata).values({
      id,
      name,
      slug,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });

    for (const [key, value] of Object.entries(defaultPreferences)) {
      await spaceDb.insert(preference).values({
        id: createId("preference"),
        key,
        value,
        createdAt: now,
        updatedAt: now,
      });
    }

    await upsertSpaceIndex(
      { id, name, slug, createdBy, createdAt: now, updatedAt: now },
      allocation.id,
      id,
    );
  } catch (error) {
    closeSpaceDb(id);
    await disableSpaceDatabase(allocation.id, id);
    throw error;
  }

  // Grant owner permission to creator (after closing initial connection)
  await grantPermission(
    id,
    ResourceType.SPACE,
    id,
    createdBy,
    Permission.OWNER,
    undefined,
    createdBy,
  );

  return {
    id,
    name,
    slug,
    createdBy: createdBy,
    preferences: defaultPreferences,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getSpace(id: string): Promise<Space | null> {
  await initializeDatabases();
  if (!(await getIndexedSpace(id))) return null;

  const spaceDb = await getSpaceDb(id);

  const result = await one(
    spaceDb.select().from(spaceMetadata).where(eq(spaceMetadata.id, id)),
  );

  if (!result) {
    return null;
  }

  // Load preferences
  const prefs = await many(
    spaceDb.select().from(preference).where(isNull(preference.userId)),
  );

  // Collected in a `Map`: preference keys are user-supplied, and
  // `preferences["__proto__"] = value` on an object literal is a silent no-op for
  // a string value, so a stored `__proto__` preference could never be read back
  // — and, being invisible, made the emptiness check below insert a default
  // brandColor row on what is supposed to be a read. `Object.fromEntries` defines
  // own keys, so every stored preference round-trips.
  const preferenceEntries = new Map(prefs.map((pref) => [pref.key, pref.value]));

  // Set default preferences if none exist
  if (preferenceEntries.size === 0) {
    const now = new Date();
    await spaceDb.insert(preference).values({
      id: createId("preference"),
      key: "brandColor",
      value: "#1e293b",
      createdAt: now,
      updatedAt: now,
    });
    preferenceEntries.set("brandColor", "#1e293b");
  }

  const preferences: Record<string, string> = Object.fromEntries(preferenceEntries);

  const memberCount = await countSpaceMembers(id);

  return {
    id: result.id,
    name: result.name,
    slug: result.slug,
    createdBy: result.createdBy,
    preferences,
    createdAt: new Date(result.createdAt),
    updatedAt: new Date(result.updatedAt),
    memberCount,
  };
}

export async function getSpaceBySlug(slug: string): Promise<Space | null> {
  await initializeDatabases();
  const indexed = (await getIndexedSpaceBySlug(slug)) ?? (await getIndexedSpace(slug));
  return indexed ? getSpace(indexed.spaceId) : null;
}

export async function listAllSpaces(): Promise<Space[]> {
  await initializeDatabases();
  const spaces = await Promise.all(
    (await listIndexedSpaces()).map(({ spaceId }) => getSpace(spaceId)),
  );
  return spaces.filter((space): space is Space => space !== null);
}

/**
 * The user's space-wide role, or undefined when they hold no space-wide grant.
 *
 * Every response that carries a `Space` to the client must set `userRole` —
 * the client caches spaces by id, so a response that omits it overwrites the
 * role the listing established and locks the user out of role-gated UI.
 */
export async function getUserSpaceRole(
  space: Space,
  userId: string,
): Promise<Permission | undefined> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) return Permission.OWNER;
  if (space.createdBy === userId) return Permission.OWNER;

  try {
    const userGroups = await getUserGroups(userId);
    return highestPermission(await spaceGrants(space, userId, userGroups));
  } catch {
    return undefined;
  }
}

/** The user's own and group-inherited role grants on the space itself. */
async function spaceGrants(
  space: Space,
  userId: string,
  userGroups: string[],
): Promise<string[]> {
  const permissions = await listUserPermissions(
    space.id,
    userId,
    userGroups,
    ResourceType.SPACE,
  );
  return permissions
    .filter((p) => p.resourceType === ResourceType.SPACE && p.resourceId === space.id)
    .map((p) => p.permission);
}

export async function listUserSpaces(userId: string): Promise<Space[]> {
  const allSpaces = await listAllSpaces();

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return allSpaces.map((s) => ({ ...s, userRole: Permission.OWNER }));
  }

  const userSpaces: Space[] = [];

  for (const space of allSpaces) {
    // Include space if user created it
    if (space.createdBy === userId) {
      userSpaces.push({ ...space, userRole: Permission.OWNER });
      continue;
    }

    // Include space if user is a member
    try {
      const userGroups = await getUserGroups(userId);
      const spacePermission = highestPermission(
        await spaceGrants(space, userId, userGroups),
      );
      if (spacePermission) {
        userSpaces.push({ ...space, userRole: spacePermission });
      } else if (await hasAnyResourceScopedAccess(space.id, userId, userGroups)) {
        // No space-wide grant, but the user has a document/tree/category
        // grant in this space — surface the space so they can reach it.
        // Leave userRole unset so space-wide UI stays gated as before.
        userSpaces.push({ ...space });
      }
    } catch {}
  }

  return userSpaces;
}

export async function listPublicSpaces(): Promise<Space[]> {
  const allSpaces = await listAllSpaces();
  const publicSpaces: Space[] = [];

  for (const space of allSpaces) {
    try {
      const canView = await hasPermission(
        space.id,
        ResourceType.SPACE,
        space.id,
        "",
        Permission.VIEWER,
        [PUBLIC_GROUP],
      );
      if (canView) {
        publicSpaces.push({ ...space, userRole: "viewer" });
      }
    } catch {}
  }

  return publicSpaces;
}

export async function updateSpace(
  id: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space | null> {
  const existing = await getSpace(id);
  if (!existing) {
    return null;
  }

  // Check if slug is changing and if new slug already exists
  if (slug !== existing.slug) {
    const existingSpace = await getSpaceBySlug(slug);
    if (existingSpace && existingSpace.id !== id) {
      throw new Error(`Space with slug "${slug}" already exists`);
    }
  }

  const now = new Date();
  const spaceDb = await getSpaceDb(id);

  await spaceDb
    .update(spaceMetadata)
    .set({ name, slug, updatedAt: now })
    .where(eq(spaceMetadata.id, id));
  try {
    await updateIndexedSpaceMetadata(id, { name, slug, updatedAt: now });
  } catch (indexError) {
    try {
      await spaceDb
        .update(spaceMetadata)
        .set({
          name: existing.name,
          slug: existing.slug,
          updatedAt: existing.updatedAt,
        })
        .where(eq(spaceMetadata.id, id));
    } catch (compensationError) {
      throw new AggregateError(
        [indexError, compensationError],
        `Failed to update the space index and restore metadata for space ${id}`,
      );
    }
    throw indexError;
  }

  // Update preferences if provided. A `Map` for the same reason as in `getSpace`:
  // the response has to report back a `__proto__` preference it just wrote, and
  // bracket assignment on an object would drop it.
  const updatedPreferences = new Map(Object.entries(existing.preferences));
  if (preferences) {
    for (const [key, value] of Object.entries(preferences)) {
      // Check if preference exists
      const existingPref = await one(
        spaceDb
          .select()
          .from(preference)
          .where(and(eq(preference.key, key), isNull(preference.userId))),
      );

      if (existingPref) {
        // Update existing preference
        await spaceDb
          .update(preference)
          .set({ value, updatedAt: now })
          .where(eq(preference.id, existingPref.id));
      } else {
        // Insert new preference
        await spaceDb.insert(preference).values({
          id: createId("preference"),
          key,
          value,
          createdAt: now,
          updatedAt: now,
        });
      }
      updatedPreferences.set(key, value);
    }
  }

  return {
    id,
    name,
    slug,
    createdBy: existing.createdBy,
    preferences: Object.fromEntries(updatedPreferences),
    createdAt: existing.createdAt,
    updatedAt: now,
  };
}

export async function deleteSpace(id: string): Promise<boolean> {
  await initializeDatabases();
  const databaseRecord = await getAssignedSpaceDatabase(id);
  if (!databaseRecord) return false;

  closeSpaceDb(id);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let databaseExisted = true;

  const spacePath = resolveSpaceLocation(databaseRecord.location).filePath;
  if (!isInMemoryDb() && spacePath) {
    databaseExisted = existsSync(spacePath);
    if (databaseExisted) {
      const deletedSpacesDir = join(DELETED_DIR, "spaces");
      if (!existsSync(deletedSpacesDir)) {
        mkdirSync(deletedSpacesDir, { recursive: true });
      }
      const deletedSpacePath = join(deletedSpacesDir, `${id}_${timestamp}.db`);
      renameSync(spacePath, deletedSpacePath);
    }
  }

  const uploadsPath = join(UPLOADS_DIR, id);
  if (existsSync(uploadsPath)) {
    const deletedUploadsDir = join(DELETED_DIR, "uploads");
    if (!existsSync(deletedUploadsDir)) {
      mkdirSync(deletedUploadsDir, { recursive: true });
    }
    const deletedUploadsPath = join(deletedUploadsDir, `${id}_${timestamp}`);
    renameSync(uploadsPath, deletedUploadsPath);
  }

  await markSpaceDeleted(id);

  return databaseExisted;
}

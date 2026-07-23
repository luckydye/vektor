import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { isInMemoryDb } from "#inMemoryDb";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";
import { slugify } from "#utils/utils.ts";
import {
  countSpaceMembers,
  getUserGroups,
  grantPermission,
  hasAnyResourceScopedAccess,
  hasPermission,
  listUserPermissions,
  ResourceType,
} from "./acl.ts";
import { getDatabaseFilePath } from "./connection.ts";
import {
  closeSpaceDb,
  createAllocatedSpaceDb,
  getSpaceDb,
  initializeDatabases,
} from "./db.ts";
import { createId } from "./ids.ts";
import { preference, spaceMetadata } from "./schema/space.ts";
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
} from "./spaceIndex.ts";

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
  await grantPermission(id, ResourceType.SPACE, id, createdBy, "owner");

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

  const result = await spaceDb
    .select()
    .from(spaceMetadata)
    .where(eq(spaceMetadata.id, id))
    .get();

  if (!result) {
    return null;
  }

  // Load preferences
  const prefs = await spaceDb
    .select()
    .from(preference)
    .where(isNull(preference.userId))
    .all();

  const preferences: Record<string, string> = {};
  for (const pref of prefs) {
    preferences[pref.key] = pref.value;
  }

  // Set default preferences if none exist
  if (Object.keys(preferences).length === 0) {
    const now = new Date();
    await spaceDb.insert(preference).values({
      id: createId("preference"),
      key: "brandColor",
      value: "#1e293b",
      createdAt: now,
      updatedAt: now,
    });
    preferences.brandColor = "#1e293b";
  }

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

export async function listUserSpaces(userId: string): Promise<Space[]> {
  const allSpaces = await listAllSpaces();

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return allSpaces.map((s) => ({ ...s, userRole: "owner" }));
  }

  const userSpaces: Space[] = [];

  for (const space of allSpaces) {
    // Include space if user created it
    if (space.createdBy === userId) {
      userSpaces.push({ ...space, userRole: "owner" });
      continue;
    }

    // Include space if user is a member
    try {
      const userGroups = await getUserGroups(userId);
      const permissions = await listUserPermissions(
        space.id,
        userId,
        userGroups,
        ResourceType.SPACE,
      );
      const spacePermission = permissions.find(
        (p) => p.resourceType === ResourceType.SPACE && p.resourceId === space.id,
      );
      if (spacePermission) {
        userSpaces.push({ ...space, userRole: spacePermission.permission });
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
        "viewer",
        ["public"],
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

  // Update preferences if provided
  const updatedPreferences = { ...existing.preferences };
  if (preferences) {
    for (const [key, value] of Object.entries(preferences)) {
      // Check if preference exists
      const existingPref = await spaceDb
        .select()
        .from(preference)
        .where(and(eq(preference.key, key), isNull(preference.userId)))
        .get();

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
      updatedPreferences[key] = value;
    }
  }

  return {
    id,
    name,
    slug,
    createdBy: existing.createdBy,
    preferences: updatedPreferences,
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

  const spacePath = getDatabaseFilePath(databaseRecord.databaseUrl);
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

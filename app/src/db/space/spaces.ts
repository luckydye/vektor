import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { canAccess } from "#acl/guards.ts";
import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import { highestPermission, Permission, ResourceType } from "#acl/permissions.ts";
import {
  countSpaceMembers,
  grantPermission,
  hasAnyResourceScopedAccess,
  listUserPermissions,
} from "#acl/store.ts";
import { getUserGroups } from "#acl/userGroups.ts";
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
import { openSpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference, spaceMetadata } from "#db/schema/space.ts";
import { getUserPreferences } from "#db/space/userPreferences.ts";
import { isInMemoryDb } from "#inMemoryDb";
import { canonicalSpaceSlug, spaceSlugRejection } from "#utils/slug.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

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
  /**
   * Set on a listing only: the space is reachable because the caller
   * administers the instance, not because any grant in it names them.
   */
  adminAccess?: boolean;
}

/** A caller-supplied space slug that cannot become a space URL. */
export class InvalidSpaceSlugError extends Error {}

/** A space slug another space already owns. */
export class SpaceSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Space with slug "${slug}" already exists`);
  }
}

/**
 * The database is the authority on slug uniqueness; the pre-check below only
 * turns the common case into a readable message. This maps the race that slips
 * past it onto the same failure.
 */
function isSlugUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("space_index_active_slug_unique") ||
    /UNIQUE constraint failed:\s*space_index\.slug/i.test(message)
  );
}

/**
 * The single place a caller-supplied space slug becomes a stored one, so create
 * and update cannot drift apart again — creation used to sanitize silently while
 * update stored whatever it was handed.
 */
async function resolveSpaceSlug(input: string, spaceId?: string): Promise<string> {
  const rejection = spaceSlugRejection(input);
  if (rejection) throw new InvalidSpaceSlugError(rejection);

  const slug = canonicalSpaceSlug(input);
  await initializeDatabases();
  const owner = await getIndexedSpaceBySlug(slug);
  if (owner && owner.spaceId !== spaceId) throw new SpaceSlugTakenError(slug);

  return slug;
}

export async function createSpace(
  createdBy: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space> {
  const id = createId("space");
  const now = new Date();

  slug = await resolveSpaceSlug(slug);

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
    throw isSlugUniqueViolation(error) ? new SpaceSlugTakenError(slug) : error;
  }

  // Grant owner permission to creator (after closing initial connection)
  await grantPermission(
    await openSpaceStore(id),
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
/**
 * Each space with the caller's own preferences attached — the `user:` namespace,
 * which lives in per-user rows and so is not part of the space itself.
 *
 * Every response carrying a `Space` sets it for the same reason it sets
 * `userRole`: the client caches spaces by id, so a response that omits it
 * overwrites what the last one established.
 */
async function withUserPreferences(spaces: Space[], userId: string): Promise<Space[]> {
  return await Promise.all(
    spaces.map(async (space) => ({
      ...space,
      userPreferences: await getUserPreferences(await openSpaceStore(space.id), userId),
    })),
  );
}

export async function getUserSpaceRole(
  space: Space,
  userId: string,
): Promise<Permission | undefined> {
  // Instance admins included, so a space they administer without belonging to
  // still hands the client the role the guards will decide the request at.
  if (await isInstanceAdmin(userId)) return Permission.OWNER;

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

/**
 * What the user holds in the space on their own account: their space-wide role,
 * and whether any grant in it reaches them at all. Both unset means they are not
 * a member, which for an instance admin separates a space they administer from
 * one they belong to.
 */
async function spaceMembership(
  space: Space,
  userId: string,
): Promise<{ role?: Permission; reachable: boolean }> {
  try {
    const userGroups = await getUserGroups(userId);
    const role = highestPermission(await spaceGrants(space, userId, userGroups));
    if (role) return { role, reachable: true };
    return { reachable: await hasAnyResourceScopedAccess(space.id, userId, userGroups) };
  } catch {
    return { reachable: false };
  }
}

export async function listUserSpaces(userId: string): Promise<Space[]> {
  const allSpaces = await listAllSpaces();
  const admin = await isInstanceAdmin(userId);
  const userSpaces: Space[] = [];

  for (const space of allSpaces) {
    const membership = await spaceMembership(space, userId);

    if (admin) {
      // The whole instance, at the role the guards will decide their requests
      // at. `adminAccess` is what tells the two apart in the UI.
      userSpaces.push({
        ...space,
        userRole: Permission.OWNER,
        adminAccess: !membership.reachable,
      });
    } else if (membership.role) {
      userSpaces.push({ ...space, userRole: membership.role });
    } else if (membership.reachable) {
      // No space-wide grant, but a document/tree/category grant in this space —
      // surface it so they can reach it, with `userRole` left unset so
      // space-wide UI stays gated as before.
      userSpaces.push({ ...space });
    }
  }

  return await withUserPreferences(userSpaces, userId);
}

export async function listPublicSpaces(): Promise<Space[]> {
  const allSpaces = await listAllSpaces();
  const publicSpaces: Space[] = [];

  for (const space of allSpaces) {
    try {
      const canView = await canAccess(
        space.id,
        { type: ResourceType.SPACE, id: space.id },
        null,
        Permission.VIEWER,
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

  // Only when it changes, so a space that predates these rules can still be
  // renamed.
  if (slug !== existing.slug) {
    slug = await resolveSpaceSlug(slug, id);
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
    throw isSlugUniqueViolation(indexError) ? new SpaceSlugTakenError(slug) : indexError;
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

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { countSpaceMembers, resolveGranteeName } from "#acl/directory.ts";
import { canAccess } from "#acl/guards.ts";
import { isInstanceAdmin, resolveIdentity } from "#acl/identity.ts";
import { highestPermission, Permission, ResourceType } from "#acl/permissions.ts";
import {
  grantPermission,
  hasAnyResourceScopedAccess,
  listUserPermissions,
} from "#acl/store.ts";
import { config, isInMemoryDb } from "#config";
import {
  allocateSpaceDatabase,
  deletionTime,
  disableSpaceDatabase,
  forgetSpaceDatabase,
  getAssignedSpaceDatabase,
  getIndexedSpace,
  getIndexedSpaceBySlug,
  getSpaceDatabaseRecord,
  listDeletedSpaceDatabases,
  listIndexedSpaces,
  markSpaceDeleted,
  recycleSpaceDatabase,
  updateIndexedSpaceMetadata,
  upsertSpaceIndex,
  wipeSpaceDatabase,
} from "#db/auth/spaceIndex.ts";
import { dataDirectory, resolveSpaceLocation } from "#db/client/connection.ts";
import {
  closeSpaceDb,
  createAllocatedSpaceDb,
  initializeDatabases,
} from "#db/client/db.ts";
import { many, one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference, spaceMetadata } from "#db/schema/space.ts";
import { getUserPreferences } from "#db/space/userPreferences.ts";
import { getFileStorage } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { canonicalSpaceSlug, spaceSlugRejection } from "#utils/slug.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

/** Default retention for a deleted space, in days. */
const DEFAULT_SPACE_RETENTION_DAYS = 30;

/**
 * Where a deleted local space database waits out its retention window.
 *
 * Outside `data/spaces`, because that directory is the local index:
 * `reconcileLocalSpaceIndex` indexes every database file it finds there, so a
 * deleted one left in place comes back as an active space on the next start.
 */
function archivedSpaceDatabasePath(spaceId: string): string {
  return join(dataDirectory(), "deleted", "spaces", `${spaceId}.db`);
}

/** How long deleted data is kept, `0` when a delete should purge at once. */
function retentionMs(): number {
  const configured = config().SPACE_RETENTION_DAYS?.trim();
  const days =
    configured && /^\d+$/.test(configured)
      ? Number.parseInt(configured, 10)
      : DEFAULT_SPACE_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

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
  let store: SpaceStore;
  const defaultPreferences = {
    brandColor: "#1e293b",
    [spacePreferenceKeys.workflowCreationEnabled]: "true",
    ...preferences,
  };

  try {
    await createAllocatedSpaceDb(id);
    store = await openSpaceStore(id);
    await store.tx(async (tx) => {
      await tx.db.insert(spaceMetadata).values({
        id,
        name,
        slug,
        createdBy,
        createdAt: now,
        updatedAt: now,
      });

      for (const [key, value] of Object.entries(defaultPreferences)) {
        await tx.db.insert(preference).values({
          id: createId("preference"),
          key,
          value,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

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

  // Reuse the allocated space's store for the initial owner grant.
  const targetName = await resolveGranteeName(createdBy);
  await store.tx((tx) =>
    grantPermission(
      tx,
      ResourceType.SPACE,
      id,
      { userId: createdBy, targetName },
      Permission.OWNER,
      createdBy,
    ),
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

  const { db: spaceDb } = await openSpaceStore(id);

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
  const identity = await resolveIdentity(userId);
  if (identity.isInstanceAdmin) return Permission.OWNER;

  try {
    return highestPermission(await spaceGrants(space, userId, identity.groups));
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
    const { groups } = await resolveIdentity(userId);
    const role = highestPermission(await spaceGrants(space, userId, groups));
    if (role) return { role, reachable: true };
    return { reachable: await hasAnyResourceScopedAccess(space.id, userId, groups) };
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
  store: SpaceStore,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space | null> {
  const { spaceId: id } = store;
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
  // Space metadata and preferences live together and must land together. The
  // auth index is a separate database, so update it last: an index failure can
  // still roll this transaction back.
  const updatedPreferences = new Map(Object.entries(existing.preferences));
  await store.tx(async (tx) => {
    await tx.db
      .update(spaceMetadata)
      .set({ name, slug, updatedAt: now })
      .where(eq(spaceMetadata.id, id));

    if (preferences) {
      for (const [key, value] of Object.entries(preferences)) {
        const existingPref = await one(
          tx.db
            .select()
            .from(preference)
            .where(and(eq(preference.key, key), isNull(preference.userId))),
        );

        if (existingPref) {
          await tx.db
            .update(preference)
            .set({ value, updatedAt: now })
            .where(eq(preference.id, existingPref.id));
        } else {
          await tx.db.insert(preference).values({
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

    try {
      await updateIndexedSpaceMetadata(id, { name, slug, updatedAt: now });
    } catch (indexError) {
      throw isSlugUniqueViolation(indexError)
        ? new SpaceSlugTakenError(slug)
        : indexError;
    }
  });

  return {
    id,
    name,
    slug,
    createdBy: existing.createdBy,
    preferences: Object.fromEntries(updatedPreferences),
    createdAt: existing.createdAt,
    updatedAt: now,
    // Carried over: the client caches spaces by id, so a response without it
    // overwrites the count the listing established and the sidebar reads zero.
    memberCount: existing.memberCount,
  };
}

/**
 * The space was taken out of service, but reclaiming its data did not finish.
 *
 * Distinct from a failed delete, and the reason a purge failure is not
 * swallowed: the space is gone from the instance either way, so a caller that
 * asked for a hard delete has to learn that some of the data is still there and
 * that the retention sweep will try again.
 */
export class SpacePurgeFailedError extends Error {
  constructor(spaceId: string, cause: unknown) {
    super(`Space ${spaceId} was deleted, but its data could not be reclaimed`, {
      cause,
    });
    this.name = "SpacePurgeFailedError";
  }
}

/**
 * Take a space out of service, and start the retention window on its data.
 *
 * Nothing is reclaimed here beyond the local database file, which has to leave
 * `data/spaces` or the local index resurrects it. The uploads stay where they
 * are: they are already unreachable — no route can open a deleted space — and
 * moving them would mean copying every object in the space on an object store,
 * where there is no rename. {@link purgeSpace} deletes them once the window has
 * passed, or immediately when `purge` is set.
 */
export async function deleteSpace(
  id: string,
  options: { purge?: boolean } = {},
): Promise<boolean> {
  await initializeDatabases();
  const databaseRecord = await getAssignedSpaceDatabase(id);
  if (!databaseRecord) return false;

  closeSpaceDb(id);

  let databaseExisted = true;
  const spacePath = resolveSpaceLocation(databaseRecord.location).filePath;
  if (!isInMemoryDb() && spacePath) {
    databaseExisted = existsSync(spacePath);
    if (databaseExisted) {
      const archivePath = archivedSpaceDatabasePath(id);
      mkdirSync(dirname(archivePath), { recursive: true });
      renameSync(spacePath, archivePath);
      // The journal files belong to the database that just moved; left behind
      // they are a stale WAL against whatever takes that name next.
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${spacePath}${suffix}`, { force: true });
      }
    }
  }

  await markSpaceDeleted(id);
  if (options.purge || retentionMs() === 0) {
    try {
      await purgeSpace(id);
    } catch (error) {
      // Logged here because the cause is what an operator needs and a caller
      // only sees which half failed.
      appLogger.error("Failed to purge a space during its delete", {
        spaceId: id,
        error,
      });
      throw new SpacePurgeFailedError(id, error);
    }
  }

  return databaseExisted;
}

/**
 * Delete everything a deleted space still occupies: its uploads, its database,
 * and its identity in the index. Idempotent, and the hard-delete path a data
 * subject request needs — after it there is nothing left to hand anyone.
 */
export async function purgeSpace(spaceId: string): Promise<void> {
  await initializeDatabases();
  const record = await getSpaceDatabaseRecord(spaceId);
  // A live space has to be deleted first: this reclaims its storage, and the
  // status is the only thing standing between an operator's typo and the data.
  if (record && record.status !== "deleted") {
    throw new Error(`Space ${spaceId} is ${record.status}, not deleted; delete it first`);
  }
  closeSpaceDb(spaceId);

  // Every prefix, not just the uploads layout: a space also stores git
  // repositories and extension bundles under its own id.
  await getFileStorage().deleteAll(spaceId);

  const archivePath = archivedSpaceDatabasePath(spaceId);
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${archivePath}${suffix}`, { force: true });
  }

  if (!record) return;

  const location = resolveSpaceLocation(record.location);
  if (location.filePath) {
    // A local database is its file: the archive above was it, and the record
    // has nothing left to point at.
    rmSync(location.filePath, { force: true });
    await forgetSpaceDatabase(record.id);
  } else if (location.url.startsWith("file::memory:")) {
    // The connection was the database, and closing it dropped it.
    await forgetSpaceDatabase(record.id);
  } else {
    await wipeSpaceDatabase(record);
    await recycleSpaceDatabase(record.id);
  }

  appLogger.info("Purged a deleted space", { spaceId, record: record.id });
}

/**
 * Purge every deleted space whose retention window has passed, returning the
 * ids reclaimed. One failure is logged and skipped rather than left to abort
 * the sweep: a database that cannot be reached now is retried on the next one.
 */
export async function purgeExpiredSpaces(now: Date = new Date()): Promise<string[]> {
  await initializeDatabases();
  const retention = retentionMs();
  const purged: string[] = [];

  for (const record of await listDeletedSpaceDatabases()) {
    if (!record.spaceId) continue;
    if (deletionTime(record).getTime() + retention > now.getTime()) continue;
    try {
      await purgeSpace(record.spaceId);
      purged.push(record.spaceId);
    } catch (error) {
      appLogger.error("Failed to purge a deleted space", {
        spaceId: record.spaceId,
        record: record.id,
        error,
      });
    }
  }

  return purged;
}

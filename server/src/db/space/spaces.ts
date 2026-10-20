import { and, eq, isNull } from "drizzle-orm";
import { countSpaceMembers, resolveGranteeName } from "#acl/directory.ts";
import { canAccess } from "#acl/guards.ts";
import { principalOf, type ResolvedIdentity, resolveIdentity } from "#acl/identity.ts";
import { highestPermission, Permission, ResourceType } from "#acl/permissions.ts";
import {
  grantPermission,
  hasAnyResourceScopedAccess,
  listUserPermissions,
} from "#acl/store.ts";
import { config } from "#config";
import {
  deletionTime,
  disableSpaceDatabase,
  getAssignedSpaceDatabase,
  getIndexedSpace,
  getIndexedSpaceBySlug,
  getSpaceDatabaseRecord,
  isActiveSpace,
  listDeletedSpaceDatabases,
  listIndexedSpaces,
  markSpaceDeleted,
  updateIndexedSpaceMetadata,
  upsertSpaceIndex,
} from "#db/auth/spaceIndex.ts";
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
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { canonicalSpaceSlug, spaceSlugRejection } from "#utils/slug.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

/** Default retention for a deleted space, in days. */
const DEFAULT_SPACE_RETENTION_DAYS = 30;

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
  /** The caller's own `user:` preferences, which live in per-user rows. */
  userPreferences?: Record<string, string>;
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
async function resolveSpaceSlug(
  platform: Platform,
  input: string,
  spaceId?: string,
): Promise<string> {
  const rejection = spaceSlugRejection(input);
  if (rejection) throw new InvalidSpaceSlugError(rejection);

  const slug = canonicalSpaceSlug(input);
  await initializeDatabases(platform);
  const owner = await getIndexedSpaceBySlug(platform, slug);
  if (owner && owner.spaceId !== spaceId) throw new SpaceSlugTakenError(slug);

  return slug;
}

export async function createSpace(
  platform: Platform,
  createdBy: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space> {
  const id = createId("space");
  const now = new Date();

  slug = await resolveSpaceSlug(platform, slug);

  const allocation = await platform.spaceDatabase.allocate(id);
  let store: SpaceStore;
  const defaultPreferences = {
    brandColor: "#1e293b",
    [spacePreferenceKeys.workflowCreationEnabled]: "false",
    [spacePreferenceKeys.repositoryCreationEnabled]: "false",
    ...preferences,
  };

  try {
    await createAllocatedSpaceDb(platform, id);
    store = await openSpaceStore(platform, id);
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
      platform,
      { id, name, slug, createdBy, createdAt: now, updatedAt: now },
      allocation.id,
      id,
    );
  } catch (error) {
    closeSpaceDb(platform, id);
    await disableSpaceDatabase(platform, allocation.id, id);
    throw isSlugUniqueViolation(error) ? new SpaceSlugTakenError(slug) : error;
  }

  // Reuse the allocated space's store for the initial owner grant.
  const targetName = await resolveGranteeName(platform, createdBy);
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

export async function getSpace(platform: Platform, id: string): Promise<Space | null> {
  await initializeDatabases(platform);
  if (!(await isActiveSpace(platform, id))) return null;
  return await readSpace(await openSpaceStore(platform, id));
}

/** The space's own metadata and preferences, for a space already known to be indexed. */
async function readSpace(store: SpaceStore): Promise<Space | null> {
  const { platform, spaceId: id, db: spaceDb } = store;

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

  const memberCount = await countSpaceMembers(platform, id);

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

export async function getSpaceBySlug(
  platform: Platform,
  slug: string,
): Promise<Space | null> {
  await initializeDatabases(platform);
  const indexed =
    (await getIndexedSpaceBySlug(platform, slug)) ??
    (await getIndexedSpace(platform, slug));
  return indexed ? readSpace(await openSpaceStore(platform, indexed.spaceId)) : null;
}

export async function listAllSpaces(platform: Platform): Promise<Space[]> {
  return await readIndexedSpaces(platform, readSpace);
}

/**
 * `read` over every indexed space at once, dropping the spaces it answers null for.
 * Each read gets one space's store and nothing shared, so it maps onto one call per space.
 */
async function readIndexedSpaces(
  platform: Platform,
  read: (store: SpaceStore) => Promise<Space | null>,
): Promise<Space[]> {
  await initializeDatabases(platform);
  const spaces = await Promise.all(
    (await listIndexedSpaces(platform)).map(async ({ spaceId }) =>
      read(await openSpaceStore(platform, spaceId)),
    ),
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
  platform: Platform,
  space: Space,
  userId: string,
): Promise<Permission | undefined> {
  // Instance admins included, so a space they administer without belonging to
  // still hands the client the role the guards will decide the request at.
  const identity = await resolveIdentity(platform, userId);
  if (identity.isInstanceAdmin) return Permission.OWNER;

  try {
    return highestPermission(await spaceGrants(platform, space, userId, identity.groups));
  } catch {
    return undefined;
  }
}

/** The user's own and group-inherited role grants on the space itself. */
async function spaceGrants(
  platform: Platform,
  space: Space,
  userId: string,
  userGroups: string[],
): Promise<string[]> {
  const permissions = await listUserPermissions(
    platform,
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
 * What `identity` holds in the space on their own account: their space-wide role,
 * and whether any grant in it reaches them at all. Both unset means they are not
 * a member, which for an instance admin separates a space they administer from
 * one they belong to.
 */
async function spaceMembership(
  platform: Platform,
  space: Space,
  identity: ResolvedIdentity,
): Promise<{ role?: Permission; reachable: boolean }> {
  const userId = principalOf(identity);
  try {
    const role = highestPermission(
      await spaceGrants(platform, space, userId, identity.groups),
    );
    if (role) return { role, reachable: true };
    return {
      reachable: await hasAnyResourceScopedAccess(
        platform,
        space.id,
        userId,
        identity.groups,
      ),
    };
  } catch {
    return { reachable: false };
  }
}

/**
 * The space as `identity`'s listing shows it, or null when it is not theirs to see.
 * The `user:` preferences ride along because the client caches spaces by id, so a
 * response that omits them overwrites what the last one established.
 */
async function describeSpaceFor(
  store: SpaceStore,
  identity: ResolvedIdentity,
): Promise<Space | null> {
  const space = await readSpace(store);
  if (!space) return null;

  const membership = await spaceMembership(store.platform, space, identity);
  let listed: Space;
  if (identity.isInstanceAdmin) {
    // The whole instance, at the role the guards will decide their requests
    // at. `adminAccess` is what tells the two apart in the UI.
    listed = { ...space, userRole: Permission.OWNER, adminAccess: !membership.reachable };
  } else if (membership.role) {
    listed = { ...space, userRole: membership.role };
  } else if (membership.reachable) {
    // No space-wide grant, but a document/tree/category grant in this space —
    // surface it so they can reach it, with `userRole` left unset so
    // space-wide UI stays gated as before.
    listed = { ...space };
  } else {
    return null;
  }
  return {
    ...listed,
    userPreferences: await getUserPreferences(store, principalOf(identity)),
  };
}

export async function listUserSpaces(
  platform: Platform,
  userId: string,
): Promise<Space[]> {
  const identity = await resolveIdentity(platform, userId);
  return await readIndexedSpaces(platform, (store) => describeSpaceFor(store, identity));
}

/** The space behind `slug` as `userId`'s listing shows it, or null when it is not theirs to see. */
export async function findUserSpaceBySlug(
  platform: Platform,
  userId: string,
  slug: string,
): Promise<Space | null> {
  await initializeDatabases(platform);
  const indexed = await getIndexedSpaceBySlug(platform, slug);
  if (!indexed) return null;
  return await describeSpaceFor(
    await openSpaceStore(platform, indexed.spaceId),
    await resolveIdentity(platform, userId),
  );
}

export async function listPublicSpaces(platform: Platform): Promise<Space[]> {
  return await readIndexedSpaces(platform, async (store) => {
    const space = await readSpace(store);
    if (!space) return null;
    try {
      const canView = await canAccess(
        platform,
        space.id,
        { type: ResourceType.SPACE, id: space.id },
        null,
        Permission.VIEWER,
      );
      return canView ? { ...space, userRole: "viewer" } : null;
    } catch {
      return null;
    }
  });
}

/** The index's copy of a space's name and slug, with a taken slug reported as such. */
async function writeIndexedSpaceMetadata(
  platform: Platform,
  spaceId: string,
  values: { name: string; slug: string; updatedAt: Date },
): Promise<void> {
  try {
    await updateIndexedSpaceMetadata(platform, spaceId, values);
  } catch (indexError) {
    throw isSlugUniqueViolation(indexError)
      ? new SpaceSlugTakenError(values.slug)
      : indexError;
  }
}

export async function updateSpace(
  store: SpaceStore,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space | null> {
  const { spaceId: id } = store;
  const existing = await getSpace(store.platform, id);
  if (!existing) {
    return null;
  }

  // Only when it changes, so a space that predates these rules can still be
  // renamed.
  if (slug !== existing.slug) {
    slug = await resolveSpaceSlug(store.platform, slug, id);
  }

  const now = new Date();
  // The index is written before the space's transaction, so a taken slug fails
  // before the space changes, and it is restored if that transaction then fails.
  await writeIndexedSpaceMetadata(store.platform, id, { name, slug, updatedAt: now });
  const updatedPreferences = new Map(Object.entries(existing.preferences));
  await store
    .tx(async (tx) => {
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
    })
    .catch(async (error) => {
      await updateIndexedSpaceMetadata(store.platform, id, {
        name: existing.name,
        slug: existing.slug,
        updatedAt: existing.updatedAt,
      });
      throw error;
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
  platform: Platform,
  id: string,
  options: { purge?: boolean } = {},
): Promise<boolean> {
  await initializeDatabases(platform);
  const databaseRecord = await getAssignedSpaceDatabase(platform, id);
  if (!databaseRecord) return false;

  closeSpaceDb(platform, id);
  const databaseExisted = await platform.spaceDatabase.archive(id);

  await markSpaceDeleted(platform, id);
  if (options.purge || retentionMs() === 0) {
    try {
      await purgeSpace(platform, id);
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
export async function purgeSpace(platform: Platform, spaceId: string): Promise<void> {
  await initializeDatabases(platform);
  const record = await getSpaceDatabaseRecord(platform, spaceId);
  // A live space has to be deleted first: this reclaims its storage, and the
  // status is the only thing standing between an operator's typo and the data.
  if (record && record.status !== "deleted") {
    throw new Error(`Space ${spaceId} is ${record.status}, not deleted; delete it first`);
  }
  closeSpaceDb(platform, spaceId);

  // Every prefix, not just the uploads layout: a space also stores git
  // repositories and extension bundles under its own id.
  await platform.blobStore.deleteAll(spaceId);

  await platform.spaceDatabase.purge(spaceId);
  if (!record) return;

  appLogger.info("Purged a deleted space", { spaceId, record: record.id });
}

/**
 * Purge every deleted space whose retention window has passed, returning the
 * ids reclaimed. One failure is logged and skipped rather than left to abort
 * the sweep: a database that cannot be reached now is retried on the next one.
 */
export async function purgeExpiredSpaces(
  platform: Platform,
  now: Date = new Date(),
): Promise<string[]> {
  await initializeDatabases(platform);
  const retention = retentionMs();
  const purged: string[] = [];

  for (const record of await listDeletedSpaceDatabases(platform)) {
    if (!record.spaceId) continue;
    if (deletionTime(record).getTime() + retention > now.getTime()) continue;
    try {
      await purgeSpace(platform, record.spaceId);
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

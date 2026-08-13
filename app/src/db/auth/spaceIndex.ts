import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { grantPermission } from "#acl/store.ts";
import {
  closeDatabase,
  createDatabase,
  getAuthDatabaseUrl,
  getAuthDb,
  getLocalSpaceDatabaseUrl,
  getLocalSpacesDirectory,
  isLocalDatabaseMode,
  resolveSpaceLocation,
  withoutDatabaseCredentials,
} from "#db/client/connection.ts";
import { many, one } from "#db/client/query.ts";
import { spaceIndex } from "#db/schema/auth.ts";
import { spaceMetadata } from "#db/schema/space.ts";
import { isInMemoryDb } from "#inMemoryDb";
import { appLogger } from "#observability/logger.ts";
import { availableSpaceSlug, isReservedSpaceSlug } from "#utils/utils.ts";

export type SpaceIndexRecord = typeof spaceIndex.$inferSelect;
export type ActiveSpaceIndexRecord = SpaceIndexRecord & {
  spaceId: string;
  name: string;
  slug: string;
  createdBy: string;
};

export interface IndexedSpaceMetadata {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function databaseRecordId(): string {
  return `database_${crypto.randomUUID()}`;
}

function canonicalRemoteDatabaseEndpoint(databaseUrl: string): string {
  const parsed = new URL(withoutDatabaseCredentials(databaseUrl));
  const secure =
    parsed.protocol === "libsql:"
      ? parsed.searchParams.get("tls") !== "0"
      : parsed.protocol === "https:" || parsed.protocol === "wss:";
  const protocol = secure ? "https:" : "http:";

  return new URL(`${protocol}//${parsed.host}${parsed.pathname}`).toString();
}

function asActiveSpace(
  record: SpaceIndexRecord | undefined,
): ActiveSpaceIndexRecord | null {
  if (
    record?.status !== "active" ||
    !record.spaceId ||
    !record.name ||
    !record.slug ||
    !record.createdBy
  ) {
    return null;
  }
  return record as ActiveSpaceIndexRecord;
}

function sanitizeRemoteSpaceDatabaseUrl(databaseUrl: string): string {
  if (isLocalDatabaseMode()) {
    throw new Error("Hosted database registration requires a remote VEKTOR_DATABASE_URL");
  }

  const sanitizedUrl = withoutDatabaseCredentials(databaseUrl.trim());
  if (
    !sanitizedUrl ||
    !["libsql:", "https:", "http:", "wss:", "ws:"].includes(
      new URL(sanitizedUrl).protocol,
    )
  ) {
    throw new Error("A remote libSQL database URL is required");
  }
  if (
    canonicalRemoteDatabaseEndpoint(sanitizedUrl) ===
    canonicalRemoteDatabaseEndpoint(getAuthDatabaseUrl())
  ) {
    throw new Error("The auth database cannot be registered as a space database");
  }
  return sanitizedUrl;
}

async function inspectSpaceDatabase(
  location: string,
): Promise<IndexedSpaceMetadata | null> {
  const database = createDatabase(resolveSpaceLocation(location).url);
  try {
    const schemaObjects = await many<{ name: string }>(
      database,
      sql.raw("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"),
    );
    if (schemaObjects.length === 0) return null;
    if (!schemaObjects.some(({ name }) => name === "space_metadata")) {
      throw new Error(
        "The database is not empty and does not contain space metadata; recreate it before enabling",
      );
    }

    const [metadata, ...additionalMetadata] = await many(
      database.select().from(spaceMetadata),
    );
    if (!metadata) {
      throw new Error(
        "The database contains a partially initialized space schema; recreate it before enabling",
      );
    }
    if (additionalMetadata.length > 0) {
      throw new Error("The database contains metadata for multiple spaces");
    }
    return metadata;
  } finally {
    closeDatabase(database);
  }
}

export async function registerAvailableSpaceDatabase(
  databaseUrl: string,
): Promise<SpaceIndexRecord> {
  const sanitizedUrl = sanitizeRemoteSpaceDatabaseUrl(databaseUrl);
  const metadata = await inspectSpaceDatabase(sanitizedUrl);
  if (metadata) {
    throw new Error(
      "The database already contains a space; use `vektor space attach <url>` instead",
    );
  }

  const authDb = getAuthDb();
  const existing = await one(
    authDb.select().from(spaceIndex).where(eq(spaceIndex.location, sanitizedUrl)),
  );
  if (existing) {
    if (existing.status !== "available") {
      throw new Error(`Database is already registered with status "${existing.status}"`);
    }
    return existing;
  }

  const now = new Date();
  const registered = await one(
    authDb
      .insert(spaceIndex)
      .values({
        id: databaseRecordId(),
        location: sanitizedUrl,
        status: "available",
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  if (!registered) {
    throw new Error("Failed to register space database");
  }
  return registered;
}

export async function attachExistingSpaceDatabase(
  databaseUrl: string,
): Promise<ActiveSpaceIndexRecord> {
  const sanitizedUrl = sanitizeRemoteSpaceDatabaseUrl(databaseUrl);
  const database = createDatabase(sanitizedUrl);
  let metadata: IndexedSpaceMetadata | undefined;
  try {
    metadata = await one(database.select().from(spaceMetadata));
  } finally {
    closeDatabase(database);
  }
  if (!metadata) {
    throw new Error("The database does not contain space metadata");
  }

  const authDb = getAuthDb();
  const [byUrl, bySpace] = await Promise.all([
    one(authDb.select().from(spaceIndex).where(eq(spaceIndex.location, sanitizedUrl))),
    one(authDb.select().from(spaceIndex).where(eq(spaceIndex.spaceId, metadata.id))),
  ]);
  if (byUrl && bySpace && byUrl.id !== bySpace.id) {
    throw new Error("The database URL and space ID are already registered separately");
  }

  const existing = byUrl ?? bySpace;
  const recordId = existing?.id ?? databaseRecordId();
  if (existing) {
    await authDb
      .update(spaceIndex)
      .set({
        location: sanitizedUrl,
        status: "claimed",
        spaceId: metadata.id,
        updatedAt: new Date(),
      })
      .where(eq(spaceIndex.id, existing.id));
  } else {
    const now = new Date();
    await authDb.insert(spaceIndex).values({
      id: recordId,
      location: sanitizedUrl,
      status: "claimed",
      spaceId: metadata.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  await upsertSpaceIndex(metadata, recordId, metadata.id);
  return (await getIndexedSpace(metadata.id))!;
}

export async function listSpaceDatabaseRecords(): Promise<SpaceIndexRecord[]> {
  return many(getAuthDb().select().from(spaceIndex));
}

export async function enableSpaceDatabase(recordId: string): Promise<SpaceIndexRecord> {
  const authDb = getAuthDb();
  const existing = await one(
    authDb.select().from(spaceIndex).where(eq(spaceIndex.id, recordId)),
  );
  if (!existing) throw new Error(`Database record not found: ${recordId}`);
  if (existing.status !== "claimed" && existing.status !== "disabled") {
    throw new Error(
      `Only claimed or disabled database records can be enabled; current status is "${existing.status}"`,
    );
  }

  const metadata = await inspectSpaceDatabase(existing.location);
  if (metadata) {
    if (existing.spaceId !== metadata.id) {
      throw new Error(
        `Database metadata does not match the claimed space: expected ${existing.spaceId ?? "an assigned space ID"}, found ${metadata.id}`,
      );
    }

    const indexedForSpace = await one(
      authDb
        .select({ id: spaceIndex.id })
        .from(spaceIndex)
        .where(eq(spaceIndex.spaceId, metadata.id)),
    );
    if (indexedForSpace && indexedForSpace.id !== existing.id) {
      throw new Error(`Space is already assigned to another database: ${metadata.id}`);
    }

    if (existing.status === "disabled") {
      const reclaimed = await one(
        authDb
          .update(spaceIndex)
          .set({ status: "claimed", updatedAt: new Date() })
          .where(
            and(
              eq(spaceIndex.id, existing.id),
              eq(spaceIndex.status, "disabled"),
              eq(spaceIndex.spaceId, metadata.id),
            ),
          )
          .returning({ id: spaceIndex.id }),
      );
      if (!reclaimed) {
        throw new Error(
          `Database record changed while it was being enabled: ${recordId}`,
        );
      }
    }

    try {
      await grantPermission(
        metadata.id,
        ResourceType.SPACE,
        metadata.id,
        metadata.createdBy,
        Permission.OWNER,
        undefined,
        metadata.createdBy,
      );
    } catch (error) {
      if (existing.status === "disabled") {
        await authDb
          .update(spaceIndex)
          .set({ status: "disabled", updatedAt: new Date() })
          .where(
            and(
              eq(spaceIndex.id, existing.id),
              eq(spaceIndex.status, "claimed"),
              eq(spaceIndex.spaceId, metadata.id),
            ),
          );
      }
      throw error;
    }

    const activated = await one(
      authDb
        .update(spaceIndex)
        .set({
          status: "active",
          spaceId: metadata.id,
          name: metadata.name,
          slug: metadata.slug,
          createdBy: metadata.createdBy,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        })
        .where(
          and(
            eq(spaceIndex.id, existing.id),
            eq(spaceIndex.status, "claimed"),
            eq(spaceIndex.spaceId, metadata.id),
          ),
        )
        .returning(),
    );
    if (!activated) {
      throw new Error(`Database record changed while it was being enabled: ${recordId}`);
    }
    return activated;
  }

  if (existing.status === "claimed") {
    // Without a lease, an empty claim is indistinguishable from a creator that
    // has not initialized its database yet. Only failed (disabled) claims are
    // safe to return to the available pool.
    throw new Error(
      `Database claim may still be in use; only an empty disabled database can be enabled: ${recordId}`,
    );
  }

  const enabled = await one(
    authDb
      .update(spaceIndex)
      .set({
        status: "available",
        spaceId: null,
        name: null,
        slug: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(spaceIndex.id, recordId),
          eq(spaceIndex.status, existing.status),
          existing.spaceId
            ? eq(spaceIndex.spaceId, existing.spaceId)
            : isNull(spaceIndex.spaceId),
        ),
      )
      .returning(),
  );
  if (!enabled) {
    throw new Error(`Database record changed while it was being enabled: ${recordId}`);
  }
  return enabled;
}

export async function allocateSpaceDatabase(spaceId: string): Promise<SpaceIndexRecord> {
  const authDb = getAuthDb();
  const now = new Date();

  if (isInMemoryDb() || isLocalDatabaseMode()) {
    const location = isInMemoryDb()
      ? `memory:${spaceId}`
      : getLocalSpaceDatabaseUrl(spaceId);
    const claimed = await one(
      authDb
        .insert(spaceIndex)
        .values({
          id: databaseRecordId(),
          location,
          status: "claimed",
          spaceId,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    if (!claimed) {
      throw new Error(`Failed to allocate a space database for ${spaceId}`);
    }
    return claimed;
  }

  for (;;) {
    const available = await one(
      authDb.select().from(spaceIndex).where(eq(spaceIndex.status, "available")).limit(1),
    );
    if (!available) {
      throw new Error(
        "No hosted space database is available; register one with `vektor space register <url>`",
      );
    }

    const claimed = await one(
      authDb
        .update(spaceIndex)
        .set({ status: "claimed", spaceId, updatedAt: now })
        .where(and(eq(spaceIndex.id, available.id), eq(spaceIndex.status, "available")))
        .returning(),
    );
    if (claimed) return claimed;
  }
}

export async function disableSpaceDatabase(
  recordId: string,
  expectedSpaceId: string,
): Promise<void> {
  await getAuthDb()
    .update(spaceIndex)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(
      and(
        eq(spaceIndex.id, recordId),
        eq(spaceIndex.status, "claimed"),
        eq(spaceIndex.spaceId, expectedSpaceId),
      ),
    );
}

export async function getAssignedSpaceDatabase(
  spaceId: string,
): Promise<SpaceIndexRecord | null> {
  return (
    (await one(
      getAuthDb()
        .select()
        .from(spaceIndex)
        .where(
          and(
            eq(spaceIndex.spaceId, spaceId),
            inArray(spaceIndex.status, ["claimed", "active"]),
          ),
        ),
    )) ?? null
  );
}

export async function upsertSpaceIndex(
  metadata: IndexedSpaceMetadata,
  recordId: string,
  expectedSpaceId: string,
): Promise<void> {
  if (metadata.id !== expectedSpaceId) {
    throw new Error(
      `Space metadata does not match the database claim: expected ${expectedSpaceId}, found ${metadata.id}`,
    );
  }

  const updated = await one(
    getAuthDb()
      .update(spaceIndex)
      .set({
        spaceId: metadata.id,
        name: metadata.name,
        slug: metadata.slug,
        createdBy: metadata.createdBy,
        status: "active",
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      })
      .where(
        // The space ID is the claim generation: each creation allocates a fresh
        // ID, so a stale creator cannot activate a recovered or reassigned row.
        and(
          eq(spaceIndex.id, recordId),
          eq(spaceIndex.status, "claimed"),
          eq(spaceIndex.spaceId, expectedSpaceId),
        ),
      )
      .returning({ id: spaceIndex.id }),
  );
  if (!updated) {
    throw new Error(
      `Database claim changed while space ${expectedSpaceId} was being activated`,
    );
  }
}

export async function updateIndexedSpaceMetadata(
  spaceId: string,
  values: { name: string; slug: string; updatedAt: Date },
): Promise<void> {
  const updated = await one(
    getAuthDb()
      .update(spaceIndex)
      .set(values)
      .where(and(eq(spaceIndex.spaceId, spaceId), eq(spaceIndex.status, "active")))
      .returning({ id: spaceIndex.id }),
  );
  if (!updated) {
    throw new Error(`Active space index record not found: ${spaceId}`);
  }
}

export async function getIndexedSpace(
  spaceId: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await one(
    getAuthDb()
      .select()
      .from(spaceIndex)
      .where(and(eq(spaceIndex.spaceId, spaceId), eq(spaceIndex.status, "active"))),
  );
  return asActiveSpace(record);
}

export async function getIndexedSpaceBySlug(
  slug: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await one(
    getAuthDb()
      .select()
      .from(spaceIndex)
      .where(and(eq(spaceIndex.slug, slug), eq(spaceIndex.status, "active"))),
  );
  return asActiveSpace(record);
}

export async function listIndexedSpaces(): Promise<ActiveSpaceIndexRecord[]> {
  const records = await many(
    getAuthDb().select().from(spaceIndex).where(eq(spaceIndex.status, "active")),
  );
  return records
    .map((record) => asActiveSpace(record))
    .filter((record): record is ActiveSpaceIndexRecord => record !== null);
}

export async function listActiveSpaceIds(): Promise<string[]> {
  return (await listIndexedSpaces()).map(({ spaceId }) => spaceId);
}

export async function markSpaceDeleted(spaceId: string): Promise<void> {
  await getAuthDb()
    .update(spaceIndex)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(spaceIndex.spaceId, spaceId));
}

async function indexLocalSpace(
  location: string,
  metadata: IndexedSpaceMetadata,
): Promise<void> {
  const authDb = getAuthDb();
  const existing = await one(
    authDb
      .select()
      .from(spaceIndex)
      .where(or(eq(spaceIndex.location, location), eq(spaceIndex.spaceId, metadata.id))),
  );
  const recordId = existing?.id ?? databaseRecordId();
  if (existing) {
    await authDb
      .update(spaceIndex)
      .set({
        location,
        status: "claimed",
        spaceId: metadata.id,
        updatedAt: new Date(),
      })
      .where(eq(spaceIndex.id, existing.id));
  } else {
    await authDb.insert(spaceIndex).values({
      id: recordId,
      location,
      status: "claimed",
      spaceId: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    });
  }
  await upsertSpaceIndex(metadata, recordId, metadata.id);
}

/**
 * Whether `/{slug}/` can address a space at all.
 *
 * Deliberately far narrower than `spaceSlugRejection`, which says what somebody
 * may type into a slug field. A stored `my_team`, `team--alpha` or `Team` is
 * served at exactly that path — `[spaceSlug]` matches any single segment and the
 * lookup is exact — so the repair below has to leave it alone. Rewriting it to
 * the canonical form would 404 every link that space already has, which is the
 * harm the repair exists to prevent.
 */
function isUnreachableSpaceSlug(slug: string): boolean {
  return slug.trim() === "" || /[/?#]/.test(slug);
}

/**
 * Which discovered spaces have to move off their slug, and where each one lands.
 *
 * A space on `docs`, `login` or `api` is shadowed by a static route in
 * `src/pages/`: it is listed in the switcher and every click lands on Vektor's
 * own page. A space sharing a slug with another one is hidden behind it. Neither
 * has a UI path to a rename — reaching a space's settings means opening the
 * space, which is exactly what is impossible — so nothing but this frees them.
 *
 * Planned over every space at once, in two passes, because the order spaces are
 * discovered in must not decide who keeps their URL: every slug that already
 * routes is claimed before any replacement is picked. A single pass lets a space
 * being repaired take the slug of one that was reachable all along, which both
 * moves that space's URL out from under it and — since `claimedElsewhere` covers
 * the rows the partial unique index also covers — fails the index write.
 */
export function planSpaceSlugRepairs(
  spaces: readonly { id: string; slug: string }[],
  claimedElsewhere: ReadonlySet<string>,
): Map<string, string> {
  const taken = new Set(claimedElsewhere);
  const displaced: { id: string; slug: string }[] = [];

  for (const space of spaces) {
    const reachable =
      !isUnreachableSpaceSlug(space.slug) && !isReservedSpaceSlug(space.slug);
    if (reachable && !taken.has(space.slug)) {
      taken.add(space.slug);
      continue;
    }
    displaced.push(space);
  }

  const repairs = new Map<string, string>();
  for (const space of displaced) {
    const slug = availableSpaceSlug(space.slug, (candidate) => taken.has(candidate));
    taken.add(slug);
    repairs.set(space.id, slug);
  }
  return repairs;
}

/**
 * Slugs held by active spaces that this reconcile is not about to rewrite.
 *
 * A repaired slug has to clear these too: `space_index_active_slug_unique` spans
 * every active row, so a candidate chosen without them fails the write — and a
 * throw out of `reconcileLocalSpaceIndex` is permanent, see `initializeDatabases`.
 */
async function slugsClaimedOutsideDiscovery(
  discoveredSpaceIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const active = await many(
    getAuthDb()
      .select({ spaceId: spaceIndex.spaceId, slug: spaceIndex.slug })
      .from(spaceIndex)
      .where(eq(spaceIndex.status, "active")),
  );

  const claimed = new Set<string>();
  for (const row of active) {
    if (!row.slug) continue;
    if (row.spaceId && discoveredSpaceIds.has(row.spaceId)) continue;
    claimed.add(row.slug);
  }
  return claimed;
}

async function storeRepairedSlug(
  location: string,
  spaceId: string,
  slug: string,
): Promise<void> {
  const database = createDatabase(resolveSpaceLocation(location).url);
  try {
    await database
      .update(spaceMetadata)
      .set({ slug, updatedAt: new Date() })
      .where(eq(spaceMetadata.id, spaceId));
  } finally {
    closeDatabase(database);
  }
}

export async function reconcileLocalSpaceIndex(): Promise<void> {
  if (!isLocalDatabaseMode() || isInMemoryDb()) return;

  const spacesDirectory = getLocalSpacesDirectory();
  if (!existsSync(spacesDirectory)) mkdirSync(spacesDirectory, { recursive: true });

  const discoveredFiles = readdirSync(spacesDirectory)
    .filter((name) => name.endsWith(".db"))
    .map((name) => path.join(spacesDirectory, name));
  const discoveredPaths = new Set(discoveredFiles.map((file) => path.resolve(file)));

  const discovered: { location: string; metadata: IndexedSpaceMetadata }[] = [];
  for (const databasePath of discoveredFiles) {
    const location = getLocalSpaceDatabaseUrl(path.basename(databasePath, ".db"));
    const database = createDatabase(resolveSpaceLocation(location).url);
    try {
      const metadata = await one(database.select().from(spaceMetadata));
      if (metadata) discovered.push({ location, metadata });
    } catch {
      // Ignore files that are not initialized space databases. They remain on
      // disk for an operator to inspect and are never added to the live index.
    } finally {
      closeDatabase(database);
    }
  }

  const repairs = planSpaceSlugRepairs(
    discovered.map(({ metadata }) => metadata),
    await slugsClaimedOutsideDiscovery(
      new Set(discovered.map(({ metadata }) => metadata.id)),
    ),
  );

  for (const { location, metadata } of discovered) {
    const repairedSlug = repairs.get(metadata.id);
    if (repairedSlug) {
      appLogger.warn("Renamed a space that could not be reached at its own slug", {
        spaceId: metadata.id,
        previousSlug: metadata.slug,
        slug: repairedSlug,
      });
      // The index is what routes, and what `getSpace` reports, so a space
      // database that refuses the write is still indexed under the repaired slug
      // rather than left shadowed.
      await storeRepairedSlug(location, metadata.id, repairedSlug).catch(
        (error: unknown) =>
          appLogger.error("Failed to store a repaired space slug", {
            spaceId: metadata.id,
            slug: repairedSlug,
            error,
          }),
      );
    }

    // One space that cannot be indexed must not take the process with it:
    // `initializeDatabases` caches its promise, so a throw here would reject
    // every later database call for the lifetime of the process.
    await indexLocalSpace(
      location,
      repairedSlug ? { ...metadata, slug: repairedSlug } : metadata,
    ).catch((error: unknown) =>
      appLogger.error("Failed to index a local space", {
        spaceId: metadata.id,
        location: withoutDatabaseCredentials(location),
        error,
      }),
    );
  }

  const indexedDatabases = await many(
    getAuthDb()
      .select()
      .from(spaceIndex)
      .where(inArray(spaceIndex.status, ["claimed", "active"])),
  );
  for (const indexed of indexedDatabases) {
    if (!indexed.spaceId) continue;
    const filePath = resolveSpaceLocation(indexed.location).filePath;
    if (!filePath?.startsWith(`${spacesDirectory}${path.sep}`)) continue;
    if (!discoveredPaths.has(path.resolve(filePath))) {
      await markSpaceDeleted(indexed.spaceId);
    }
  }
}

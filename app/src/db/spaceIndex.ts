import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isInMemoryDb } from "#inMemoryDb";
import { grantPermission, Permission, ResourceType } from "./acl.ts";
import {
  closeDatabase,
  createDatabase,
  getAuthDatabaseUrl,
  getAuthDb,
  getDatabaseFilePath,
  getLocalSpaceDatabaseUrl,
  getLocalSpacesDirectory,
  isLocalDatabaseMode,
  withoutDatabaseCredentials,
} from "./connection.ts";
import { spaceIndex } from "./schema/auth.ts";
import { spaceMetadata } from "./schema/space.ts";

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
    !record ||
    record.status !== "active" ||
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
  databaseUrl: string,
): Promise<IndexedSpaceMetadata | null> {
  const database = createDatabase(databaseUrl);
  try {
    const schemaObjects = await database.all<{ name: string }>(
      sql.raw("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"),
    );
    if (schemaObjects.length === 0) return null;
    if (!schemaObjects.some(({ name }) => name === "space_metadata")) {
      throw new Error(
        "The database is not empty and does not contain space metadata; recreate it before enabling",
      );
    }

    const [metadata, ...additionalMetadata] = await database
      .select()
      .from(spaceMetadata)
      .all();
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
  const existing = await authDb
    .select()
    .from(spaceIndex)
    .where(eq(spaceIndex.databaseUrl, sanitizedUrl))
    .get();
  if (existing) {
    if (existing.status !== "available") {
      throw new Error(`Database is already registered with status "${existing.status}"`);
    }
    return existing;
  }

  const now = new Date();
  return authDb
    .insert(spaceIndex)
    .values({
      id: databaseRecordId(),
      databaseUrl: sanitizedUrl,
      status: "available",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export async function attachExistingSpaceDatabase(
  databaseUrl: string,
): Promise<ActiveSpaceIndexRecord> {
  const sanitizedUrl = sanitizeRemoteSpaceDatabaseUrl(databaseUrl);
  const database = createDatabase(sanitizedUrl);
  let metadata: IndexedSpaceMetadata | undefined;
  try {
    metadata = await database.select().from(spaceMetadata).get();
  } finally {
    closeDatabase(database);
  }
  if (!metadata) {
    throw new Error("The database does not contain space metadata");
  }

  const authDb = getAuthDb();
  const [byUrl, bySpace] = await Promise.all([
    authDb
      .select()
      .from(spaceIndex)
      .where(eq(spaceIndex.databaseUrl, sanitizedUrl))
      .get(),
    authDb.select().from(spaceIndex).where(eq(spaceIndex.spaceId, metadata.id)).get(),
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
        databaseUrl: sanitizedUrl,
        status: "claimed",
        spaceId: metadata.id,
        updatedAt: new Date(),
      })
      .where(eq(spaceIndex.id, existing.id));
  } else {
    const now = new Date();
    await authDb.insert(spaceIndex).values({
      id: recordId,
      databaseUrl: sanitizedUrl,
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
  return getAuthDb().select().from(spaceIndex).all();
}

export async function enableSpaceDatabase(recordId: string): Promise<SpaceIndexRecord> {
  const authDb = getAuthDb();
  const existing = await authDb
    .select()
    .from(spaceIndex)
    .where(eq(spaceIndex.id, recordId))
    .get();
  if (!existing) throw new Error(`Database record not found: ${recordId}`);
  if (existing.status !== "claimed" && existing.status !== "disabled") {
    throw new Error(
      `Only claimed or disabled database records can be enabled; current status is "${existing.status}"`,
    );
  }

  const metadata = await inspectSpaceDatabase(existing.databaseUrl);
  if (metadata) {
    if (existing.spaceId !== metadata.id) {
      throw new Error(
        `Database metadata does not match the claimed space: expected ${existing.spaceId ?? "an assigned space ID"}, found ${metadata.id}`,
      );
    }

    const indexedForSpace = await authDb
      .select({ id: spaceIndex.id })
      .from(spaceIndex)
      .where(eq(spaceIndex.spaceId, metadata.id))
      .get();
    if (indexedForSpace && indexedForSpace.id !== existing.id) {
      throw new Error(`Space is already assigned to another database: ${metadata.id}`);
    }

    if (existing.status === "disabled") {
      const reclaimed = await authDb
        .update(spaceIndex)
        .set({ status: "claimed", updatedAt: new Date() })
        .where(
          and(
            eq(spaceIndex.id, existing.id),
            eq(spaceIndex.status, "disabled"),
            eq(spaceIndex.spaceId, metadata.id),
          ),
        )
        .returning({ id: spaceIndex.id })
        .get();
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

    const activated = await authDb
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
      .returning()
      .get();
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

  const enabled = await authDb
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
    .returning()
    .get();
  if (!enabled) {
    throw new Error(`Database record changed while it was being enabled: ${recordId}`);
  }
  return enabled;
}

export async function allocateSpaceDatabase(spaceId: string): Promise<SpaceIndexRecord> {
  const authDb = getAuthDb();
  const now = new Date();

  if (isInMemoryDb() || isLocalDatabaseMode()) {
    const databaseUrl = isInMemoryDb()
      ? `memory:${spaceId}`
      : getLocalSpaceDatabaseUrl(spaceId);
    return authDb
      .insert(spaceIndex)
      .values({
        id: databaseRecordId(),
        databaseUrl,
        status: "claimed",
        spaceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  for (;;) {
    const available = await authDb
      .select()
      .from(spaceIndex)
      .where(eq(spaceIndex.status, "available"))
      .limit(1)
      .get();
    if (!available) {
      throw new Error(
        "No hosted space database is available; register one with `vektor space register <url>`",
      );
    }

    const claimed = await authDb
      .update(spaceIndex)
      .set({ status: "claimed", spaceId, updatedAt: now })
      .where(and(eq(spaceIndex.id, available.id), eq(spaceIndex.status, "available")))
      .returning()
      .get();
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
    (await getAuthDb()
      .select()
      .from(spaceIndex)
      .where(
        and(
          eq(spaceIndex.spaceId, spaceId),
          inArray(spaceIndex.status, ["claimed", "active"]),
        ),
      )
      .get()) ?? null
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

  const updated = await getAuthDb()
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
    .returning({ id: spaceIndex.id })
    .get();
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
  const updated = await getAuthDb()
    .update(spaceIndex)
    .set(values)
    .where(and(eq(spaceIndex.spaceId, spaceId), eq(spaceIndex.status, "active")))
    .returning({ id: spaceIndex.id })
    .get();
  if (!updated) {
    throw new Error(`Active space index record not found: ${spaceId}`);
  }
}

export async function getIndexedSpace(
  spaceId: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await getAuthDb()
    .select()
    .from(spaceIndex)
    .where(and(eq(spaceIndex.spaceId, spaceId), eq(spaceIndex.status, "active")))
    .get();
  return asActiveSpace(record);
}

export async function getIndexedSpaceBySlug(
  slug: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await getAuthDb()
    .select()
    .from(spaceIndex)
    .where(and(eq(spaceIndex.slug, slug), eq(spaceIndex.status, "active")))
    .get();
  return asActiveSpace(record);
}

export async function listIndexedSpaces(): Promise<ActiveSpaceIndexRecord[]> {
  const records = await getAuthDb()
    .select()
    .from(spaceIndex)
    .where(eq(spaceIndex.status, "active"))
    .all();
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
  databaseUrl: string,
  metadata: IndexedSpaceMetadata,
): Promise<void> {
  const authDb = getAuthDb();
  const existing = await authDb
    .select()
    .from(spaceIndex)
    .where(
      or(eq(spaceIndex.databaseUrl, databaseUrl), eq(spaceIndex.spaceId, metadata.id)),
    )
    .get();
  const recordId = existing?.id ?? databaseRecordId();
  if (existing) {
    await authDb
      .update(spaceIndex)
      .set({
        databaseUrl,
        status: "claimed",
        spaceId: metadata.id,
        updatedAt: new Date(),
      })
      .where(eq(spaceIndex.id, existing.id));
  } else {
    await authDb.insert(spaceIndex).values({
      id: recordId,
      databaseUrl,
      status: "claimed",
      spaceId: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    });
  }
  await upsertSpaceIndex(metadata, recordId, metadata.id);
}

export async function reconcileLocalSpaceIndex(): Promise<void> {
  if (!isLocalDatabaseMode() || isInMemoryDb()) return;

  const spacesDirectory = getLocalSpacesDirectory();
  if (!existsSync(spacesDirectory)) mkdirSync(spacesDirectory, { recursive: true });

  const discoveredFiles = readdirSync(spacesDirectory)
    .filter((name) => name.endsWith(".db"))
    .map((name) => path.join(spacesDirectory, name));
  const discoveredPaths = new Set(discoveredFiles.map((file) => path.resolve(file)));

  for (const databasePath of discoveredFiles) {
    const databaseUrl = getLocalSpaceDatabaseUrl(path.basename(databasePath, ".db"));
    const database = createDatabase(databaseUrl);
    let metadata: IndexedSpaceMetadata | undefined;
    try {
      metadata = await database.select().from(spaceMetadata).get();
    } catch {
      // Ignore files that are not initialized space databases. They remain on
      // disk for an operator to inspect and are never added to the live index.
    } finally {
      closeDatabase(database);
    }
    if (metadata) await indexLocalSpace(databaseUrl, metadata);
  }

  const indexedDatabases = await getAuthDb()
    .select()
    .from(spaceIndex)
    .where(inArray(spaceIndex.status, ["claimed", "active"]))
    .all();
  for (const indexed of indexedDatabases) {
    if (!indexed.spaceId) continue;
    const filePath = getDatabaseFilePath(indexed.databaseUrl);
    if (!filePath || !filePath.startsWith(`${spacesDirectory}${path.sep}`)) continue;
    if (!discoveredPaths.has(path.resolve(filePath))) {
      await markSpaceDeleted(indexed.spaceId);
    }
  }
}

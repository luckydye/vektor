import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isInMemoryDb } from "#config";
import {
  authTokenFromDatabaseUrl,
  closeDatabase,
  createDatabase,
  type Database,
  type DatabaseCredentials,
  getAuthDatabaseUrl,
  getAuthDb,
  getLocalSpaceDatabaseUrl,
  getLocalSpacesDirectory,
  isLocalDatabaseMode,
  resolveSpaceLocation,
  withoutDatabaseCredentials,
} from "#db/client/connection.ts";
import { exec, many, one } from "#db/client/query.ts";
import { spaceIndex } from "#db/schema/auth.ts";
import { spaceMetadata } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";
import { appLogger } from "#observability/logger.ts";

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

/** The `space_index` columns holding an encrypted per-database token. */
type EncryptedSpaceDatabaseToken = Pick<
  SpaceIndexRecord,
  "authTokenCiphertext" | "authTokenIv" | "authTokenAuthTag"
>;

/** Column values holding `token`, encrypted. */
export function encryptSpaceDatabaseToken(token: string): EncryptedSpaceDatabaseToken {
  const encrypted = encryptSecret(token);
  return {
    authTokenCiphertext: encrypted.ciphertext,
    authTokenIv: encrypted.iv,
    authTokenAuthTag: encrypted.authTag,
  };
}

/**
 * The stored token, or undefined when the row has none. A row written under a
 * different secrets key throws rather than decrypting to the wrong token.
 */
function decryptSpaceDatabaseToken(row: EncryptedSpaceDatabaseToken): string | undefined {
  if (!row.authTokenCiphertext || !row.authTokenIv || !row.authTokenAuthTag) {
    return undefined;
  }
  return decryptSecret({
    ciphertext: row.authTokenCiphertext,
    iv: row.authTokenIv,
    authTag: row.authTokenAuthTag,
  });
}

/**
 * What to authenticate a space's connection with.
 *
 * Every hosted database carries its own token, so a leaked credential reads one
 * tenant rather than all of them. A hosted record without one is refused rather
 * than falling back to the auth database's credential, which would read every space.
 */
export function spaceDatabaseCredentials(
  record: Pick<
    SpaceIndexRecord,
    "id" | "location" | "authTokenCiphertext" | "authTokenIv" | "authTokenAuthTag"
  >,
): DatabaseCredentials {
  if (resolveSpaceLocation(record.location).url.startsWith("file:")) return {};

  const authToken = decryptSpaceDatabaseToken(record);
  if (!authToken) {
    throw new Error(
      `Space database ${record.id} has no token; set one with \`vektor space token ${record.id} <token>\``,
    );
  }
  return { authToken };
}

async function inspectSpaceDatabase(
  location: string,
  credentials: DatabaseCredentials,
): Promise<IndexedSpaceMetadata | null> {
  const database = createDatabase(resolveSpaceLocation(location).url, credentials);
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

/**
 * The token a registration stores: the explicit one, else the credential
 * embedded in the URL the operator supplied. The URL itself is stored stripped,
 * so this is the only chance to capture it.
 */
function registrationAuthToken(
  databaseUrl: string,
  authToken: string | undefined,
): string {
  const token = authToken?.trim() || authTokenFromDatabaseUrl(databaseUrl.trim());
  if (!token) {
    throw new Error(
      "A hosted space database requires its own token; pass --token or include ?authToken= in the URL",
    );
  }
  return token;
}

export async function registerAvailableSpaceDatabase(
  databaseUrl: string,
  authToken?: string,
): Promise<SpaceIndexRecord> {
  const sanitizedUrl = sanitizeRemoteSpaceDatabaseUrl(databaseUrl);
  const token = registrationAuthToken(databaseUrl, authToken);
  const metadata = await inspectSpaceDatabase(sanitizedUrl, { authToken: token });
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
    return (
      (await one(
        authDb
          .update(spaceIndex)
          .set({ ...encryptSpaceDatabaseToken(token), updatedAt: new Date() })
          .where(eq(spaceIndex.id, existing.id))
          .returning(),
      )) ?? existing
    );
  }

  const now = new Date();
  const registered = await one(
    authDb
      .insert(spaceIndex)
      .values({
        id: databaseRecordId(),
        location: sanitizedUrl,
        status: "available",
        ...encryptSpaceDatabaseToken(token),
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
  authToken?: string,
): Promise<ActiveSpaceIndexRecord> {
  const sanitizedUrl = sanitizeRemoteSpaceDatabaseUrl(databaseUrl);
  const token = registrationAuthToken(databaseUrl, authToken);
  const database = createDatabase(sanitizedUrl, { authToken: token });
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
  const tokenColumns = encryptSpaceDatabaseToken(token);
  if (existing) {
    await authDb
      .update(spaceIndex)
      .set({
        location: sanitizedUrl,
        status: "claimed",
        spaceId: metadata.id,
        ...tokenColumns,
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
      ...tokenColumns,
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

  const metadata = await inspectSpaceDatabase(
    existing.location,
    spaceDatabaseCredentials(existing),
  );
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

/**
 * Store `authToken` as this database's own credential.
 *
 * Verified against the database before it is persisted, so a typo fails here
 * rather than at the next space open.
 */
export async function setSpaceDatabaseAuthToken(
  recordId: string,
  authToken: string,
): Promise<SpaceIndexRecord> {
  const authDb = getAuthDb();
  const existing = await one(
    authDb.select().from(spaceIndex).where(eq(spaceIndex.id, recordId)),
  );
  if (!existing) throw new Error(`Database record not found: ${recordId}`);

  const location = resolveSpaceLocation(existing.location);
  if (location.url.startsWith("file:")) {
    throw new Error("Local space databases do not authenticate with a token");
  }

  const database = createDatabase(location.url, { authToken });
  try {
    await many(database, sql.raw("SELECT 1"));
  } catch (error) {
    throw new Error(
      `The token was rejected by ${withoutDatabaseCredentials(existing.location)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    closeDatabase(database);
  }

  const updated = await one(
    authDb
      .update(spaceIndex)
      .set({ ...encryptSpaceDatabaseToken(authToken), updatedAt: new Date() })
      .where(eq(spaceIndex.id, recordId))
      .returning(),
  );
  if (!updated) throw new Error(`Failed to store the token for ${recordId}`);
  return updated;
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

/**
 * How many spaces this user created that still hold a database. Counted from
 * the index rather than from owner grants: those live one per space database,
 * and this gates creation on a path that must not open every space to answer.
 * A deleted space frees its slot; a disabled one still occupies its storage.
 */
export async function countSpacesCreatedBy(userId: string): Promise<number> {
  const counted = await one(
    getAuthDb()
      .select({ spaces: sql<number>`count(*)` })
      .from(spaceIndex)
      .where(
        and(
          eq(spaceIndex.createdBy, userId),
          inArray(spaceIndex.status, ["active", "disabled"]),
        ),
      ),
  );
  return counted?.spaces ?? 0;
}

export async function listActiveSpaceIds(): Promise<string[]> {
  return (await listIndexedSpaces()).map(({ spaceId }) => spaceId);
}

export async function markSpaceDeleted(spaceId: string): Promise<void> {
  const now = new Date();
  await getAuthDb()
    .update(spaceIndex)
    .set({ status: "deleted", deletedAt: now, updatedAt: now })
    .where(eq(spaceIndex.spaceId, spaceId));
}

/**
 * Every deleted space still holding its data, oldest deletion first, so a purge
 * reclaims in the order the retention window expires.
 */
export async function listDeletedSpaceDatabases(): Promise<SpaceIndexRecord[]> {
  const records = await many(
    getAuthDb().select().from(spaceIndex).where(eq(spaceIndex.status, "deleted")),
  );
  return records.sort((a, b) => deletionTime(a).getTime() - deletionTime(b).getTime());
}

/**
 * When a deleted space's retention window started. Rows deleted before
 * `deleted_at` existed fall back to `updatedAt`, which for a deleted row is
 * the deletion itself.
 */
export function deletionTime(record: SpaceIndexRecord): Date {
  return record.deletedAt ?? record.updatedAt;
}

/**
 * Drop every object in a space database, releasing its storage.
 *
 * A hosted database belongs to the pool rather than to the space that borrowed
 * it, and libSQL has no API to destroy one from a client connection — so a
 * purge empties it instead and {@link recycleSpaceDatabase} returns it to the
 * pool for the next space.
 */
export async function wipeSpaceDatabase(record: SpaceIndexRecord): Promise<void> {
  const location = resolveSpaceLocation(record.location);
  const database = createDatabase(location.url, spaceDatabaseCredentials(record));
  try {
    // Dropping in an arbitrary order otherwise trips a reference from a table
    // that has not been dropped yet.
    await exec(database, sql.raw("PRAGMA foreign_keys = OFF"));
    const objects = await many<{ type: string; name: string }>(
      database,
      sql.raw(
        "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')",
      ),
    );
    for (const object of objects) {
      const quoted = `"${object.name.replaceAll('"', '""')}"`;
      await exec(
        database,
        sql.raw(
          object.type === "view"
            ? `DROP VIEW IF EXISTS ${quoted}`
            : `DROP TABLE IF EXISTS ${quoted}`,
        ),
      );
    }
    // The dropped pages stay in the file until it is rebuilt. A host that
    // refuses VACUUM keeps them as free space rather than as data, which is
    // reclaimed by the next space to be allocated this database.
    await exec(database, sql.raw("VACUUM")).catch((error: unknown) =>
      appLogger.warn("Could not vacuum a purged space database", {
        record: record.id,
        error,
      }),
    );
  } finally {
    closeDatabase(database);
  }
}

/**
 * Return a purged database to the pool, forgetting which space held it. The
 * token stays: it authenticates the database, not the space.
 */
export async function recycleSpaceDatabase(recordId: string): Promise<void> {
  const now = new Date();
  await getAuthDb()
    .update(spaceIndex)
    .set({
      status: "available",
      spaceId: null,
      name: null,
      slug: null,
      createdBy: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .where(eq(spaceIndex.id, recordId));
}

/**
 * Drop the record itself, for a database that no longer exists — a purged local
 * file. A recycled hosted database keeps its row; there is nothing left here to
 * hand the next space.
 */
export async function forgetSpaceDatabase(recordId: string): Promise<void> {
  await getAuthDb().delete(spaceIndex).where(eq(spaceIndex.id, recordId));
}

/** The index row for a space whatever its status, for deletion bookkeeping. */
export async function getSpaceDatabaseRecord(
  spaceId: string,
): Promise<SpaceIndexRecord | null> {
  return (
    (await one(
      getAuthDb().select().from(spaceIndex).where(eq(spaceIndex.spaceId, spaceId)),
    )) ?? null
  );
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
  const values = {
    location,
    status: "active" as const,
    spaceId: metadata.id,
    name: metadata.name,
    slug: metadata.slug,
    createdBy: metadata.createdBy,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
  if (existing) {
    await authDb.update(spaceIndex).set(values).where(eq(spaceIndex.id, existing.id));
  } else {
    await authDb.insert(spaceIndex).values({
      id: recordId,
      ...values,
    });
  }
}

/**
 * A copied local database is still useful even when its original slug is
 * already present. Give the copy the first free URL and persist that choice in
 * the space database, which remains the authority for its metadata. Hosted
 * attachments stay strict because silently changing a remote database would
 * be surprising and may race another Vektor instance.
 */
export async function resolveLocalSpaceSlugCollision(
  authDb: Database,
  spaceDb: Database,
  metadata: IndexedSpaceMetadata,
): Promise<IndexedSpaceMetadata> {
  const owner = await one(
    authDb
      .select({ spaceId: spaceIndex.spaceId })
      .from(spaceIndex)
      .where(and(eq(spaceIndex.slug, metadata.slug), eq(spaceIndex.status, "active"))),
  );
  if (!owner || owner.spaceId === metadata.id) return metadata;

  let counter = 2;
  let slug: string;
  for (;;) {
    slug = `${metadata.slug}-${counter}`;
    const candidateOwner = await one(
      authDb
        .select({ spaceId: spaceIndex.spaceId })
        .from(spaceIndex)
        .where(and(eq(spaceIndex.slug, slug), eq(spaceIndex.status, "active"))),
    );
    if (!candidateOwner || candidateOwner.spaceId === metadata.id) break;
    counter++;
  }

  const updatedAt = new Date();
  await spaceDb
    .update(spaceMetadata)
    .set({ slug, updatedAt })
    .where(eq(spaceMetadata.id, metadata.id));
  appLogger.warn("Renamed a local space whose slug was already in use", {
    spaceId: metadata.id,
    previousSlug: metadata.slug,
    slug,
  });
  return { ...metadata, slug, updatedAt };
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
    const location = getLocalSpaceDatabaseUrl(path.basename(databasePath, ".db"));
    const database = createDatabase(resolveSpaceLocation(location).url);
    let metadata: IndexedSpaceMetadata | undefined;
    try {
      metadata = await one(database.select().from(spaceMetadata));
      if (metadata) {
        metadata = await resolveLocalSpaceSlugCollision(getAuthDb(), database, metadata);
      }
    } catch {
      // Ignore files that are not initialized space databases. They remain on
      // disk for an operator to inspect and are never added to the live index.
    } finally {
      closeDatabase(database);
    }
    if (!metadata) continue;
    const space = metadata;

    // `initializeDatabases` caches its promise, so a throw here would reject
    // every later database call for the life of the process. Two space files
    // claiming one slug is how that happens: the index refuses the second.
    await indexLocalSpace(location, space).catch((error: unknown) =>
      appLogger.error("Failed to index a local space", {
        spaceId: space.id,
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

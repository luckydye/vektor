import { and, eq, inArray, sql } from "drizzle-orm";
import { type Database, getAuthDb } from "#db/client/connection.ts";
import { many, one } from "#db/client/query.ts";
import { spaceIndex } from "#db/schema/auth.ts";
import { spaceMetadata } from "#db/schema/space.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";

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

export async function listSpaceDatabaseRecords(
  platform: Platform,
): Promise<SpaceIndexRecord[]> {
  return many(getAuthDb(platform).select().from(spaceIndex));
}

export async function disableSpaceDatabase(
  platform: Platform,
  recordId: string,
  expectedSpaceId: string,
): Promise<void> {
  await getAuthDb(platform)
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
  platform: Platform,
  spaceId: string,
): Promise<SpaceIndexRecord | null> {
  return (
    (await one(
      getAuthDb(platform)
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
  platform: Platform,
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
    getAuthDb(platform)
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
  platform: Platform,
  spaceId: string,
  values: { name: string; slug: string; updatedAt: Date },
): Promise<void> {
  const updated = await one(
    getAuthDb(platform)
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
  platform: Platform,
  spaceId: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await one(
    getAuthDb(platform)
      .select()
      .from(spaceIndex)
      .where(and(eq(spaceIndex.spaceId, spaceId), eq(spaceIndex.status, "active"))),
  );
  return asActiveSpace(record);
}

export async function getIndexedSpaceBySlug(
  platform: Platform,
  slug: string,
): Promise<ActiveSpaceIndexRecord | null> {
  const record = await one(
    getAuthDb(platform)
      .select()
      .from(spaceIndex)
      .where(and(eq(spaceIndex.slug, slug), eq(spaceIndex.status, "active"))),
  );
  return asActiveSpace(record);
}

export async function listIndexedSpaces(
  platform: Platform,
): Promise<ActiveSpaceIndexRecord[]> {
  const records = await many(
    getAuthDb(platform).select().from(spaceIndex).where(eq(spaceIndex.status, "active")),
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
export async function countSpacesCreatedBy(
  platform: Platform,
  userId: string,
): Promise<number> {
  const counted = await one(
    getAuthDb(platform)
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

export async function listActiveSpaceIds(platform: Platform): Promise<string[]> {
  return (await listIndexedSpaces(platform)).map(({ spaceId }) => spaceId);
}

export async function markSpaceDeleted(
  platform: Platform,
  spaceId: string,
): Promise<void> {
  const now = new Date();
  await getAuthDb(platform)
    .update(spaceIndex)
    .set({ status: "deleted", deletedAt: now, updatedAt: now })
    .where(eq(spaceIndex.spaceId, spaceId));
}

/**
 * Every deleted space still holding its data, oldest deletion first, so a purge
 * reclaims in the order the retention window expires.
 */
export async function listDeletedSpaceDatabases(
  platform: Platform,
): Promise<SpaceIndexRecord[]> {
  const records = await many(
    getAuthDb(platform).select().from(spaceIndex).where(eq(spaceIndex.status, "deleted")),
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
 * Drop the record itself, for a database that no longer exists — a purged local
 * file. A recycled hosted database keeps its row; there is nothing left here to
 * hand the next space.
 */
export async function forgetSpaceDatabase(
  platform: Platform,
  recordId: string,
): Promise<void> {
  await getAuthDb(platform).delete(spaceIndex).where(eq(spaceIndex.id, recordId));
}

/** The index row for a space whatever its status, for deletion bookkeeping. */
export async function getSpaceDatabaseRecord(
  platform: Platform,
  spaceId: string,
): Promise<SpaceIndexRecord | null> {
  return (
    (await one(
      getAuthDb(platform)
        .select()
        .from(spaceIndex)
        .where(eq(spaceIndex.spaceId, spaceId)),
    )) ?? null
  );
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

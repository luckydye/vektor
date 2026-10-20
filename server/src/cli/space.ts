import {
  attachExistingSpaceDatabase,
  enableSpaceDatabase,
  getAssignedSpaceDatabase,
  listActiveSpaceIds,
  listSpaceDatabaseRecords,
  registerAvailableSpaceDatabase,
  setSpaceDatabaseAuthToken,
  spaceDatabaseCredentials,
} from "#db/auth/spaceIndex.ts";
import {
  closeDatabase,
  createDatabase,
  resolveSpaceLocation,
} from "#db/client/connection.ts";
import { initializeDatabases } from "#db/client/db.ts";
import { initSpaceDbSchema } from "#db/client/init.ts";
import { purgeExpiredSpaces, purgeSpace } from "#db/space/spaces.ts";
import type { Platform } from "#platform/platform.ts";

export async function commandSpaceRegister(
  platform: Platform,
  databaseUrl: string,
  authToken?: string,
): Promise<void> {
  await initializeDatabases(platform);
  const database = await registerAvailableSpaceDatabase(platform, databaseUrl, authToken);
  process.stdout.write(`${database.id}\t${database.status}\t${database.location}\n`);
}

export async function commandSpaceList(platform: Platform): Promise<void> {
  await initializeDatabases(platform);
  const databases = await listSpaceDatabaseRecords(platform);
  for (const database of databases) {
    process.stdout.write(
      `${database.id}\t${database.status}\t${database.spaceId ?? "-"}\t${database.location}\n`,
    );
  }
}

export async function commandSpaceAttach(
  platform: Platform,
  databaseUrl: string,
  authToken?: string,
): Promise<void> {
  await initializeDatabases(platform);
  const space = await attachExistingSpaceDatabase(platform, databaseUrl, authToken);
  process.stdout.write(`${space.spaceId}\t${space.slug}\t${space.name}\n`);
}

export async function commandSpaceEnable(
  platform: Platform,
  databaseId: string,
): Promise<void> {
  await initializeDatabases(platform);
  const database = await enableSpaceDatabase(platform, databaseId);
  process.stdout.write(`${database.id}\t${database.status}\t${database.location}\n`);
}

export async function commandSpaceToken(
  platform: Platform,
  databaseId: string,
  authToken: string,
): Promise<void> {
  await initializeDatabases(platform);
  await setSpaceDatabaseAuthToken(platform, databaseId, authToken);
  process.stdout.write(`${databaseId}\tok\n`);
}

/**
 * Reclaim deleted spaces. Named, one space is purged whatever its retention
 * window says — the hard delete a data subject request needs; otherwise every
 * space whose window has passed is swept, the same work the server does hourly.
 */
export async function commandSpacePurge(
  platform: Platform,
  spaceId?: string,
): Promise<void> {
  await initializeDatabases(platform);
  if (spaceId) {
    await purgeSpace(platform, spaceId);
    process.stdout.write(`${spaceId}\tpurged\n`);
    return;
  }
  const purged = await purgeExpiredSpaces(platform);
  for (const id of purged) process.stdout.write(`${id}\tpurged\n`);
  process.stdout.write(`${purged.length} space(s) purged\n`);
}

/** Migrate space databases up front, rather than on their first open. */
export async function commandSpaceMigrate(
  platform: Platform,
  spaceId?: string,
): Promise<void> {
  await initializeDatabases(platform);
  const spaceIds = spaceId ? [spaceId] : await listActiveSpaceIds(platform);

  let failed = 0;
  for (const id of spaceIds) {
    const record = await getAssignedSpaceDatabase(platform, id);
    if (!record) {
      failed++;
      process.stdout.write(`${id}\terror\tspace database not found\n`);
      continue;
    }

    const location = resolveSpaceLocation(record.location);
    // An in-memory space is the connection that holds it; a second one here
    // would migrate a private empty database.
    if (location.url.startsWith("file::memory:")) {
      process.stdout.write(`${id}\tskipped\tin-memory\n`);
      continue;
    }

    const spaceDb = createDatabase(
      platform,
      location.url,
      spaceDatabaseCredentials(record),
    );
    try {
      const applied = await initSpaceDbSchema(spaceDb, { local: location.localFile });
      const detail = applied.length ? applied.join(",") : "-";
      process.stdout.write(
        `${id}\t${applied.length ? "migrated" : "current"}\t${detail}\n`,
      );
    } catch (error) {
      failed++;
      process.stdout.write(`${id}\terror\t${(error as Error).message}\n`);
    } finally {
      closeDatabase(platform, spaceDb);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} of ${spaceIds.length} space databases failed to migrate`);
  }
}

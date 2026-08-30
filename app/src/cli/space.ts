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

export async function commandSpaceRegister(
  databaseUrl: string,
  authToken?: string,
): Promise<void> {
  await initializeDatabases();
  const database = await registerAvailableSpaceDatabase(databaseUrl, authToken);
  process.stdout.write(`${database.id}\t${database.status}\t${database.location}\n`);
}

export async function commandSpaceList(): Promise<void> {
  await initializeDatabases();
  const databases = await listSpaceDatabaseRecords();
  for (const database of databases) {
    process.stdout.write(
      `${database.id}\t${database.status}\t${database.spaceId ?? "-"}\t${database.location}\n`,
    );
  }
}

export async function commandSpaceAttach(
  databaseUrl: string,
  authToken?: string,
): Promise<void> {
  await initializeDatabases();
  const space = await attachExistingSpaceDatabase(databaseUrl, authToken);
  process.stdout.write(`${space.spaceId}\t${space.slug}\t${space.name}\n`);
}

export async function commandSpaceEnable(databaseId: string): Promise<void> {
  await initializeDatabases();
  const database = await enableSpaceDatabase(databaseId);
  process.stdout.write(`${database.id}\t${database.status}\t${database.location}\n`);
}

export async function commandSpaceToken(
  databaseId: string,
  authToken: string,
): Promise<void> {
  await initializeDatabases();
  await setSpaceDatabaseAuthToken(databaseId, authToken);
  process.stdout.write(`${databaseId}\tok\n`);
}

/** Migrate space databases up front, rather than on their first open. */
export async function commandSpaceMigrate(spaceId?: string): Promise<void> {
  await initializeDatabases();
  const spaceIds = spaceId ? [spaceId] : await listActiveSpaceIds();

  let failed = 0;
  for (const id of spaceIds) {
    const record = await getAssignedSpaceDatabase(id);
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

    const spaceDb = createDatabase(location.url, spaceDatabaseCredentials(record));
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
      closeDatabase(spaceDb);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} of ${spaceIds.length} space databases failed to migrate`);
  }
}

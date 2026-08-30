import {
  attachExistingSpaceDatabase,
  enableSpaceDatabase,
  listSpaceDatabaseRecords,
  registerAvailableSpaceDatabase,
  setSpaceDatabaseAuthToken,
} from "#db/auth/spaceIndex.ts";
import { initializeDatabases } from "#db/client/db.ts";

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

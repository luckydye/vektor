import { initializeDatabases } from "#db/db.ts";
import {
  attachExistingSpaceDatabase,
  enableSpaceDatabase,
  listSpaceDatabaseRecords,
  registerAvailableSpaceDatabase,
} from "#db/spaceIndex.ts";

export async function commandSpaceRegister(databaseUrl: string): Promise<void> {
  await initializeDatabases();
  const database = await registerAvailableSpaceDatabase(databaseUrl);
  process.stdout.write(`${database.id}\t${database.status}\t${database.databaseUrl}\n`);
}

export async function commandSpaceList(): Promise<void> {
  await initializeDatabases();
  const databases = await listSpaceDatabaseRecords();
  for (const database of databases) {
    process.stdout.write(
      `${database.id}\t${database.status}\t${database.spaceId ?? "-"}\t${database.databaseUrl}\n`,
    );
  }
}

export async function commandSpaceAttach(databaseUrl: string): Promise<void> {
  await initializeDatabases();
  const space = await attachExistingSpaceDatabase(databaseUrl);
  process.stdout.write(`${space.spaceId}\t${space.slug}\t${space.name}\n`);
}

export async function commandSpaceEnable(databaseId: string): Promise<void> {
  await initializeDatabases();
  const database = await enableSpaceDatabase(databaseId);
  process.stdout.write(`${database.id}\t${database.status}\t${database.databaseUrl}\n`);
}

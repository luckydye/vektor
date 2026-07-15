import { existsSync } from "node:fs";
import {
  closeDatabase,
  createDatabase,
  type Database,
  getAuthDb,
  getDatabaseFilePath,
} from "./connection.ts";
import { initSpaceDbSchema, prepareAuthDb } from "./init.ts";
import * as schema from "./schema.ts";
import { getAssignedSpaceDatabase, reconcileLocalSpaceIndex } from "./spaceIndex.ts";

declare global {
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_cache: Map<string, Database> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_preparation: Map<string, Promise<void>> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_opening: Map<string, Promise<Database>> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_database_initialization: Promise<void> | undefined;
}

const spaceDbCache =
  globalThis.__vektor_space_db_cache ??
  (globalThis.__vektor_space_db_cache = new Map<string, Database>());
const spaceDbPreparation =
  globalThis.__vektor_space_db_preparation ??
  (globalThis.__vektor_space_db_preparation = new Map<string, Promise<void>>());
// In-flight opens keyed by space ID. The first caller for an uncached space
// creates the connection and runs schema preparation; concurrent callers await
// this same promise instead of opening (and leaking) a second connection.
const spaceDbOpening =
  globalThis.__vektor_space_db_opening ??
  (globalThis.__vektor_space_db_opening = new Map<string, Promise<Database>>());

function startDatabaseInitialization(): Promise<void> {
  if (!globalThis.__vektor_database_initialization) {
    globalThis.__vektor_database_initialization = (async () => {
      await prepareAuthDb(getAuthDb());
      await reconcileLocalSpaceIndex();
    })();
  }
  return globalThis.__vektor_database_initialization;
}

export function initializeDatabases(): Promise<void> {
  return startDatabaseInitialization();
}

export { getAuthDb };

async function openSpaceDb(
  spaceId: string,
  createLocalFile: boolean,
): Promise<Database> {
  await initializeDatabases();

  const cached = spaceDbCache.get(spaceId);
  if (cached) {
    const preparation = spaceDbPreparation.get(spaceId);
    if (preparation) await preparation;
    return cached;
  }

  // Reuse an in-flight open for the same space. The get()/set() pair below runs
  // synchronously within a single microtask (no await between them), so a
  // concurrent caller either misses here and starts the sole open, or observes
  // the promise the first caller just registered.
  const inFlight = spaceDbOpening.get(spaceId);
  if (inFlight) return inFlight;

  const opening = (async (): Promise<Database> => {
    const databaseRecord = await getAssignedSpaceDatabase(spaceId);
    if (!databaseRecord) {
      throw new Error(`Space database not found: ${spaceId}`);
    }

    const isMemoryDatabase = databaseRecord.databaseUrl.startsWith("memory:");
    const databaseUrl = isMemoryDatabase
      ? "file::memory:"
      : databaseRecord.databaseUrl;
    const databasePath = getDatabaseFilePath(databaseUrl);
    if (databasePath && !createLocalFile && !existsSync(databasePath)) {
      throw new Error(`Space database file not found: ${spaceId}`);
    }

    const spaceDb = createDatabase(databaseUrl);
    // Cache before applying schema so concurrent first requests share both the
    // connection and its preparation promise.
    spaceDbCache.set(spaceId, spaceDb);

    const preparation = initSpaceDbSchema(spaceDb, {
      local: databaseUrl.startsWith("file:") && !isMemoryDatabase,
    }).catch((error) => {
      spaceDbCache.delete(spaceId);
      spaceDbPreparation.delete(spaceId);
      closeDatabase(spaceDb);
      throw error;
    });
    spaceDbPreparation.set(spaceId, preparation);
    await preparation;

    return spaceDb;
  })();

  spaceDbOpening.set(spaceId, opening);
  try {
    return await opening;
  } finally {
    spaceDbOpening.delete(spaceId);
  }
}

export async function getSpaceDb(spaceId: string): Promise<Database> {
  return openSpaceDb(spaceId, false);
}

export async function createAllocatedSpaceDb(spaceId: string): Promise<Database> {
  return openSpaceDb(spaceId, true);
}

export function closeSpaceDb(spaceId: string): void {
  const database = spaceDbCache.get(spaceId);
  if (database) closeDatabase(database);
  spaceDbCache.delete(spaceId);
  spaceDbPreparation.delete(spaceId);
}

export { schema };

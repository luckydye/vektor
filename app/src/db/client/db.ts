import { existsSync } from "node:fs";
import { config, isInMemoryDb } from "#config";
import {
  getAssignedSpaceDatabase,
  reconcileLocalSpaceIndex,
} from "#db/auth/spaceIndex.ts";
import {
  closeDatabase,
  createDatabase,
  type Database,
  getAuthDb,
  isMemoryBackedDatabase,
  resolveSpaceLocation,
} from "./connection.ts";
import { initSpaceDbSchema, prepareAuthDb } from "./init.ts";

declare global {
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_cache: Map<string, Database> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_last_used: Map<string, number> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_preparation: Map<string, Promise<void>> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_space_db_opening: Map<string, Promise<Database>> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_database_initialization: Promise<void> | undefined;
}

const spaceDbCache = globalThis.__vektor_space_db_cache ?? new Map<string, Database>();
globalThis.__vektor_space_db_cache = spaceDbCache;

// When each cached connection was last handed out, for eviction. Beside the
// cache rather than in it: the SSR bundle and the API are two module instances
// sharing these globals, and only one of them has to know about this map.
const spaceDbLastUsed =
  globalThis.__vektor_space_db_last_used ?? new Map<string, number>();
globalThis.__vektor_space_db_last_used = spaceDbLastUsed;

const spaceDbPreparation =
  globalThis.__vektor_space_db_preparation ?? new Map<string, Promise<void>>();
globalThis.__vektor_space_db_preparation = spaceDbPreparation;
// In-flight opens keyed by space ID. The first caller for an uncached space
// creates the connection and runs schema preparation; concurrent callers await
// this same promise instead of opening (and leaking) a second connection.
const spaceDbOpening =
  globalThis.__vektor_space_db_opening ?? new Map<string, Promise<Database>>();
globalThis.__vektor_space_db_opening = spaceDbOpening;

export function initializeDatabases(): Promise<void> {
  if (!globalThis.__vektor_database_initialization) {
    globalThis.__vektor_database_initialization = (async () => {
      await prepareAuthDb(getAuthDb());
      await reconcileLocalSpaceIndex();
    })();
  }
  return globalThis.__vektor_database_initialization;
}

export { getAuthDb };

async function openSpaceDb(spaceId: string, createLocalFile: boolean): Promise<Database> {
  await initializeDatabases();

  const cached = spaceDbCache.get(spaceId);
  if (cached) {
    touch(spaceId, cached);
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

    const location = resolveSpaceLocation(databaseRecord.location);
    if (location.filePath && !createLocalFile && !existsSync(location.filePath)) {
      throw new Error(`Space database file not found: ${spaceId}`);
    }

    const spaceDb = createDatabase(location.url);
    // Cache before applying schema so concurrent first requests share both the
    // connection and its preparation promise.
    touch(spaceId, spaceDb);

    const preparation = initSpaceDbSchema(spaceDb, {
      local: location.localFile,
    }).catch((error) => {
      spaceDbCache.delete(spaceId);
      spaceDbPreparation.delete(spaceId);
      closeDatabase(spaceDb);
      throw error;
    });
    spaceDbPreparation.set(spaceId, preparation);
    await preparation;
    evictIdleSpaceDbs();

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
  spaceDbLastUsed.delete(spaceId);
  spaceDbPreparation.delete(spaceId);
}

/** Re-insert, so the cache order stays the least-recently-used order. */
function touch(spaceId: string, database: Database): void {
  spaceDbCache.delete(spaceId);
  spaceDbCache.set(spaceId, database);
  spaceDbLastUsed.set(spaceId, Date.now());
}

/**
 * A connection is closed only after this long untouched. Callers are handed the
 * handle rather than leasing it back, so idle time is the only evidence that no
 * query is still running against it.
 */
const IDLE_BEFORE_CLOSE_MS = 60_000;

const DEFAULT_MAX_OPEN_SPACE_DBS = 128;

/** How many space connections may stay open; `0` lifts the ceiling. */
function maxOpenSpaceDbs(): number {
  // An in-memory connection holds the space itself rather than a descriptor, so
  // there is nothing to reclaim and closing one would drop the space.
  if (isInMemoryDb()) return 0;

  const configured = config().MAX_OPEN_SPACE_DBS?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_MAX_OPEN_SPACE_DBS;
  return Number.parseInt(configured, 10);
}

/**
 * Close the longest-idle connections once the cache is over its ceiling, so a
 * host with more spaces than file descriptors reopens rather than runs out.
 * Nothing is forced: when every connection is in use the cache is left over the
 * ceiling instead of a live handle being closed under its caller.
 */
function evictIdleSpaceDbs(): void {
  const limit = maxOpenSpaceDbs();
  if (limit <= 0 || spaceDbCache.size <= limit) return;

  const idleSince = Date.now() - IDLE_BEFORE_CLOSE_MS;
  for (const [spaceId, database] of spaceDbCache) {
    if (spaceDbCache.size <= limit) return;
    // An unrecorded last use is the other module instance's connection, which
    // is unread here rather than long idle.
    if ((spaceDbLastUsed.get(spaceId) ?? Date.now()) > idleSince) continue;
    // A memory-backed connection *is* the space's data — dev and test only, and
    // closing it would drop the space rather than free a descriptor.
    if (isMemoryBackedDatabase(database)) continue;
    closeSpaceDb(spaceId);
  }
}

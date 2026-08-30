import { existsSync } from "node:fs";
import { config, isInMemoryDb } from "#config";
import {
  getAssignedSpaceDatabase,
  reconcileLocalSpaceIndex,
  spaceDatabaseCredentials,
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
  var __vektor_space_db_kind: Map<string, "file" | "remote"> | undefined;
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_migrated_space_dbs: Set<string> | undefined;
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

/** What each cached connection costs to keep open; see {@link ConnectionKind}. */
const spaceDbKind =
  globalThis.__vektor_space_db_kind ?? new Map<string, ConnectionKind>();
globalThis.__vektor_space_db_kind = spaceDbKind;

/**
 * Databases this process has already migrated to the current schema.
 *
 * Reopening an evicted connection would otherwise re-read the migration version
 * over the wire, which for a hosted space is the entire cost the eviction was
 * meant to save. The version cannot go backwards, so what this process brought
 * up to date stays that way.
 *
 * Keyed by space *and* location, because that pair is what a wipe invalidates
 * and a location alone is not: a purged hosted database is emptied and returned
 * to the pool under the same URL, and another process — a second replica, or the
 * server the `purge` CLI ran beside — would otherwise still hold it as migrated
 * and open the empty database with the check skipped. The next space to claim it
 * has a fresh id, so it cannot hit that entry; attaching a different database to
 * an existing space changes the location, so it cannot either.
 */
const migratedSpaceDbs = globalThis.__vektor_migrated_space_dbs ?? new Set<string>();
globalThis.__vektor_migrated_space_dbs = migratedSpaceDbs;

function migratedKey(spaceId: string, location: string): string {
  return `${spaceId}\u0000${location}`;
}

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

    const spaceDb = createDatabase(
      location.url,
      spaceDatabaseCredentials(databaseRecord),
    );
    spaceDbKind.set(spaceId, location.filePath ? "file" : "remote");
    // Cache before applying schema so concurrent first requests share both the
    // connection and its preparation promise.
    touch(spaceId, spaceDb);

    // Pragmas are connection state and always run; the migration check is per
    // database, so a reopen of one this process already migrated skips it.
    const preparation = initSpaceDbSchema(spaceDb, {
      local: location.localFile,
      migrations: !migratedSpaceDbs.has(migratedKey(spaceId, databaseRecord.location)),
    }).then(
      () => {
        // Never for an in-memory location: every connection to one is its own
        // empty database, so the next open has to migrate again.
        if (!isMemoryBackedDatabase(spaceDb)) {
          migratedSpaceDbs.add(migratedKey(spaceId, databaseRecord.location));
        }
      },
      (error: unknown) => {
        spaceDbCache.delete(spaceId);
        spaceDbPreparation.delete(spaceId);
        spaceDbKind.delete(spaceId);
        closeDatabase(spaceDb);
        throw error;
      },
    );
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

/** @internal Raw connection entry point for the SpaceStore factory. */
export async function openSpaceDbForStore(spaceId: string): Promise<Database> {
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
  spaceDbKind.delete(spaceId);
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

/** One open file per connection, so the ceiling is a descriptor budget. */
const DEFAULT_MAX_OPEN_FILE_SPACE_DBS = 128;

/**
 * A hosted connection is an HTTP client: it holds no descriptor between
 * requests, and reopening one costs a round trip rather than an open. So the
 * ceiling here bounds memory alone, and sits far higher than the descriptor
 * budget a local file has to respect — evicting sooner would trade a few
 * kilobytes for a query on the next request.
 */
const DEFAULT_MAX_OPEN_REMOTE_SPACE_DBS = 4096;

/** What a cached connection costs to keep, which is what its ceiling bounds. */
type ConnectionKind = "file" | "remote";

/**
 * How many space connections of each kind may stay open; `0` lifts the ceiling.
 * `MAX_OPEN_SPACE_DBS` configures the descriptor budget, which is the one an
 * operator has a reason to lower.
 */
function maxOpenSpaceDbs(kind: ConnectionKind): number {
  if (kind === "remote") return DEFAULT_MAX_OPEN_REMOTE_SPACE_DBS;

  const configured = config().MAX_OPEN_SPACE_DBS?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_MAX_OPEN_FILE_SPACE_DBS;
  return Number.parseInt(configured, 10);
}

/**
 * Close the longest-idle connections once a kind is over its ceiling, so a host
 * with more spaces than file descriptors reopens rather than runs out. Nothing
 * is forced: when every connection is in use the cache is left over the ceiling
 * instead of a live handle being closed under its caller.
 *
 * Counted per kind because the two bound different resources: 128 local files
 * is a descriptor budget, while the same number of stateless HTTP clients is
 * nothing to reclaim.
 */
function evictIdleSpaceDbs(): void {
  // An in-memory connection *is* the space's data — dev and test only, and
  // closing it would drop the space rather than free anything.
  if (isInMemoryDb()) return;

  const open = new Map<ConnectionKind, string[]>();
  for (const [spaceId, database] of spaceDbCache) {
    if (isMemoryBackedDatabase(database)) continue;
    const kind = spaceDbKind.get(spaceId) ?? "remote";
    const kindSpaces = open.get(kind);
    if (kindSpaces) kindSpaces.push(spaceId);
    else open.set(kind, [spaceId]);
  }

  const idleSince = Date.now() - IDLE_BEFORE_CLOSE_MS;
  for (const [kind, kindSpaces] of open) {
    const limit = maxOpenSpaceDbs(kind);
    if (limit <= 0) continue;
    // Least recently used first: the cache is kept in that order by `touch`.
    let openCount = kindSpaces.length;
    for (const spaceId of kindSpaces) {
      if (openCount <= limit) break;
      // An unrecorded last use is the other module instance's connection, which
      // is unread here rather than long idle.
      if ((spaceDbLastUsed.get(spaceId) ?? Date.now()) > idleSince) continue;
      closeSpaceDb(spaceId);
      openCount--;
    }
  }
}

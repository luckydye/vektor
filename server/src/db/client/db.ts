import type { IdpGroupSync } from "#acl/idpSync.ts";
import type { Auth } from "#auth";
import { config, isInMemoryDb } from "#config";
import { federationOf, syncPeerClients } from "#peerFederation";
import type { OpenedSpaceDatabase, Platform } from "#platform/platform.ts";
import { type Database, getAuthDb } from "./connection.ts";
import { initSpaceDbSchema, prepareAuthDb } from "./init.ts";

/** The connections a process keeps open, on its platform so every module instance shares them. */
export interface PlatformState {
  authDb: Database | null;
  auth: Auth | null;
  idpSync: IdpGroupSync | null;
  initialization: Promise<void> | null;
  spaceDbs: Map<string, Database>;
  /** When each cached connection was last handed out, for eviction. */
  spaceDbLastUsed: Map<string, number>;
  spaceDbPreparation: Map<string, Promise<void>>;
  /**
   * In-flight opens keyed by space ID. The first caller for an uncached space
   * creates the connection and runs schema preparation; concurrent callers await
   * this same promise instead of opening (and leaking) a second connection.
   */
  spaceDbOpening: Map<string, Promise<Database>>;
  /** What each cached connection costs to keep open; see {@link ConnectionKind}. */
  spaceDbKind: Map<string, ConnectionKind>;
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
  migratedSpaceDbs: Set<string>;
}

export function createPlatformState(): PlatformState {
  return {
    authDb: null,
    auth: null,
    idpSync: null,
    initialization: null,
    spaceDbs: new Map(),
    spaceDbLastUsed: new Map(),
    spaceDbPreparation: new Map(),
    spaceDbOpening: new Map(),
    spaceDbKind: new Map(),
    migratedSpaceDbs: new Set(),
  };
}

function migratedKey(spaceId: string, location: string): string {
  return `${spaceId}\u0000${location}`;
}

export function initializeDatabases(platform: Platform): Promise<void> {
  platform.state.initialization ??= (async () => {
    await prepareAuthDb(getAuthDb(platform));
    await syncPeerClients(getAuthDb(platform), federationOf(config()));
    await platform.spaceDatabase.reconcile();
  })();
  return platform.state.initialization;
}

export { getAuthDb };

async function openSpaceDb(
  platform: Platform,
  spaceId: string,
  create: boolean,
): Promise<Database> {
  await initializeDatabases(platform);
  const {
    spaceDbs: spaceDbCache,
    spaceDbPreparation,
    spaceDbOpening,
    spaceDbKind,
    migratedSpaceDbs,
  } = platform.state;

  const cached = spaceDbCache.get(spaceId);
  if (cached) {
    touch(platform, spaceId, cached);
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
    const opened = await platform.spaceDatabase.open(spaceId, { create });
    const spaceDb = opened.database;
    const migrated = migratedKey(spaceId, opened.location);
    spaceDbKind.set(spaceId, opened.kind);
    // Cache before applying schema so concurrent first requests share both the
    // connection and its preparation promise.
    touch(platform, spaceId, spaceDb);

    // Pragmas are connection state and always run; the migration check is per
    // database, so a reopen of one this process already migrated skips it.
    const preparation = initSpaceDbSchema(platform, spaceDb, {
      local: opened.kind === "file",
      migrations: !migratedSpaceDbs.has(migrated),
    }).then(
      () => {
        // Never for an in-memory location: every connection to one is its own
        // empty database, so the next open has to migrate again.
        if (opened.kind !== "memory") migratedSpaceDbs.add(migrated);
      },
      (error: unknown) => {
        spaceDbCache.delete(spaceId);
        spaceDbPreparation.delete(spaceId);
        spaceDbKind.delete(spaceId);
        platform.spaceDatabase.close(spaceDb);
        throw error;
      },
    );
    spaceDbPreparation.set(spaceId, preparation);
    await preparation;
    evictIdleSpaceDbs(platform);

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
export async function openSpaceDbForStore(
  platform: Platform,
  spaceId: string,
): Promise<Database> {
  return openSpaceDb(platform, spaceId, false);
}

export async function createAllocatedSpaceDb(
  platform: Platform,
  spaceId: string,
): Promise<Database> {
  return openSpaceDb(platform, spaceId, true);
}

export function closeSpaceDb(platform: Platform, spaceId: string): void {
  const state = platform.state;
  const database = state.spaceDbs.get(spaceId);
  if (database) platform.spaceDatabase.close(database);
  state.spaceDbs.delete(spaceId);
  state.spaceDbLastUsed.delete(spaceId);
  state.spaceDbPreparation.delete(spaceId);
  state.spaceDbKind.delete(spaceId);
}

/** Re-insert, so the cache order stays the least-recently-used order. */
function touch(platform: Platform, spaceId: string, database: Database): void {
  platform.state.spaceDbs.delete(spaceId);
  platform.state.spaceDbs.set(spaceId, database);
  platform.state.spaceDbLastUsed.set(spaceId, Date.now());
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
type ConnectionKind = OpenedSpaceDatabase["kind"];

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
function evictIdleSpaceDbs(platform: Platform): void {
  const { spaceDbs: spaceDbCache, spaceDbKind, spaceDbLastUsed } = platform.state;
  // An in-memory connection *is* the space's data — dev and test only, and
  // closing it would drop the space rather than free anything.
  if (isInMemoryDb()) return;

  const open = new Map<ConnectionKind, string[]>();
  for (const spaceId of spaceDbCache.keys()) {
    const kind = spaceDbKind.get(spaceId) ?? "remote";
    if (kind === "memory") continue;
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
      if ((spaceDbLastUsed.get(spaceId) ?? Date.now()) > idleSince) continue;
      closeSpaceDb(platform, spaceId);
      openCount--;
    }
  }
}

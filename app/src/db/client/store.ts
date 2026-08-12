/**
 * A handle to one space's database, threaded through repository calls.
 *
 * Repositories take a `SpaceStore` instead of a `spaceId` string, so the
 * connection is resolved once per request rather than once per query, writes
 * can be grouped into a transaction, and the space a call targets is carried by
 * the handle rather than by an argument that is easy to transpose.
 */

import { changeToEvents, type SpaceChange } from "#realtime/changes.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { type Database, supportsTransactions } from "./connection.ts";
import { getSpaceDb } from "./db.ts";

/** A connection, or the transaction-scoped view of one. Both accept queries. */
export type SpaceDb = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface SpaceStore {
  readonly spaceId: string;
  readonly db: SpaceDb;
  /**
   * Run `fn` against a transaction-scoped store. Sync events emitted inside are
   * held until the commit succeeds and dropped if it throws. Nesting reuses the
   * open transaction, so the outermost call is the commit boundary.
   */
  tx<T>(fn: (store: SpaceStore) => Promise<T>): Promise<T>;
  /** Record what this write changed. Who hears about it is decided above. */
  emit(...changes: SpaceChange[]): void;
}

/**
 * The one place the data layer touches the realtime layer. Repositories emit
 * changes; translating those into topics and delivering them happens here.
 */
function publish(spaceId: string, changes: SpaceChange[]): void {
  if (changes.length === 0) return;
  sendSyncEvent(spaceId, ...changes.flatMap(changeToEvents));
}

function createStore(
  spaceId: string,
  db: SpaceDb,
  pending: SpaceChange[] | null,
): SpaceStore {
  const store: SpaceStore = {
    spaceId,
    db,
    emit(...changes) {
      if (changes.length === 0) return;
      // Outside a transaction there is no commit to wait for, so changes are
      // published immediately; inside one they are held until it lands.
      if (pending) pending.push(...changes);
      else publish(spaceId, changes);
    },
    async tx(fn) {
      if (pending) return fn(store);

      const buffered: SpaceChange[] = [];
      // An in-memory database cannot open a transaction, so there the callback
      // runs directly and the writes are not atomic. Event buffering is
      // identical either way: nothing is announced unless `fn` returns.
      const result = supportsTransactions(db)
        ? await (db as Database).transaction((txDb) =>
            fn(createStore(spaceId, txDb, buffered)),
          )
        : await fn(createStore(spaceId, db, buffered));
      publish(spaceId, buffered);
      return result;
    },
  };
  return store;
}

export async function openSpaceStore(spaceId: string): Promise<SpaceStore> {
  return createStore(spaceId, await getSpaceDb(spaceId), null);
}

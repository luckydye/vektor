/**
 * A handle to one space's database, threaded through repository calls.
 *
 * Repositories take a `SpaceStore` instead of a `spaceId` string, so the
 * connection is resolved once per request rather than once per query, writes
 * can be grouped into a transaction, and the space a call targets is carried by
 * the handle rather than by an argument that is easy to transpose.
 */

import { sendSyncEvent } from "#realtime/events.ts";
import type { RealtimeEventInput } from "#realtime/protocol.ts";
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
  /** Announce a change to subscribed clients. */
  emit(...events: RealtimeEventInput[]): void;
}

function createStore(
  spaceId: string,
  db: SpaceDb,
  pending: RealtimeEventInput[] | null,
): SpaceStore {
  const store: SpaceStore = {
    spaceId,
    db,
    emit(...events) {
      if (events.length === 0) return;
      // Outside a transaction there is no commit to wait for, so events go out
      // immediately; inside one they are buffered until it lands.
      if (pending) pending.push(...events);
      else sendSyncEvent(spaceId, ...events);
    },
    async tx(fn) {
      if (pending) return fn(store);

      const buffered: RealtimeEventInput[] = [];
      // An in-memory database cannot open a transaction, so there the callback
      // runs directly and the writes are not atomic. Event buffering is
      // identical either way: nothing is announced unless `fn` returns.
      const result = supportsTransactions(db)
        ? await (db as Database).transaction((txDb) =>
            fn(createStore(spaceId, txDb, buffered)),
          )
        : await fn(createStore(spaceId, db, buffered));
      sendSyncEvent(spaceId, ...buffered);
      return result;
    },
  };
  return store;
}

export async function openSpaceStore(spaceId: string): Promise<SpaceStore> {
  return createStore(spaceId, await getSpaceDb(spaceId), null);
}

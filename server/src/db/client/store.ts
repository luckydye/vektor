/**
 * A handle to one space's database, threaded through repository calls.
 *
 * Repositories take a `SpaceStore` instead of a `spaceId` string, so the
 * connection is resolved once per request rather than once per query, writes
 * can be grouped into a transaction, and the space a call targets is carried by
 * the handle rather than by an argument that is easy to transpose.
 */

import type { Platform } from "#platform/platform.ts";
import { changeToEvents, type SpaceChange } from "#realtime/changes.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import type { Database } from "./connection.ts";
import { openSpaceDbForStore } from "./db.ts";

export interface SpaceStore {
  /** The platform the store was opened through, for whatever else the space needs. */
  readonly platform: Platform;
  readonly spaceId: string;
  readonly db: Database;
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
  platform: Platform,
  spaceId: string,
  db: Database,
  pending: SpaceChange[] | null,
): SpaceStore {
  const store: SpaceStore = {
    platform,
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

      // Nothing is announced unless `fn` returns, however atomic the platform's
      // transaction is.
      const buffered: SpaceChange[] = [];
      const result = await platform.spaceDatabase.transaction(db, (txDb) =>
        fn(createStore(platform, spaceId, txDb, buffered)),
      );
      publish(spaceId, buffered);
      return result;
    },
  };
  return store;
}

export async function openSpaceStore(
  platform: Platform,
  spaceId: string,
): Promise<SpaceStore> {
  return createStore(
    platform,
    spaceId,
    await openSpaceDbForStore(platform, spaceId),
    null,
  );
}

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Platform } from "#platform/platform.ts";
import { assertOutsideTransaction } from "#utils/transactionScope.ts";

/**
 * A connection through any drizzle SQLite driver, or the transaction-scoped view
 * of one: a transaction is itself a SQLite database, so both accept queries.
 */
export type Database = BaseSQLiteDatabase<"async" | "sync", unknown>;

/** Throws inside a space transaction: on Durable Objects the global database is another object, so the await would block the space. */
export function getAuthDb(platform: Platform): Database {
  assertOutsideTransaction("The global database");
  platform.state.authDb ??= platform.globalDatabase.open();
  return platform.state.authDb;
}

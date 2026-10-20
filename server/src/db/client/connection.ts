import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Platform } from "#platform/platform.ts";

/**
 * A connection through any drizzle SQLite driver, or the transaction-scoped view
 * of one: a transaction is itself a SQLite database, so both accept queries.
 */
export type Database = BaseSQLiteDatabase<"async" | "sync", unknown>;

export function getAuthDb(platform: Platform): Database {
  platform.state.authDb ??= platform.globalDatabase.open();
  return platform.state.authDb;
}

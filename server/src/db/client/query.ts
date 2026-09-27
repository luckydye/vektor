/**
 * The one place a driver's result shape becomes a value.
 *
 * Drizzle's `.get()`, `.all()` and `.run()` are SQLite dialect methods: the
 * Postgres builders do not have them, and awaiting the builder is the form every
 * dialect shares. Reads go through `one`/`many` and raw statements through
 * `exec` so that shape lives in this file rather than at each call site.
 */

import type { SQL } from "drizzle-orm";
import type { Database } from "./connection.ts";
import type { SpaceDb } from "./store.ts";

/**
 * The first row a query matched, or undefined if it matched none.
 *
 * Deliberately no `limit(1)`: this is what `.get()` did, and the point of the
 * helper is that swapping the driver cannot change which rows a caller sees.
 */
export async function one<T>(query: PromiseLike<T[]>): Promise<T | undefined> {
  const rows = await query;
  return rows[0];
}

/**
 * Every row a query matched, from a builder or from a raw statement.
 *
 * The two-argument form is for SQL no builder can express — introspection of a
 * system table, say — and mirrors `exec`: a statement needs a handle to run on.
 */
export async function many<T>(query: PromiseLike<T[]>): Promise<T[]>;
export async function many<T>(db: Database | SpaceDb, statement: SQL): Promise<T[]>;
export async function many<T>(
  source: PromiseLike<T[]> | Database | SpaceDb,
  statement?: SQL,
): Promise<T[]> {
  if (statement) return (source as Database).all<T>(statement);
  return source as PromiseLike<T[]>;
}

/** Run a statement for its effect, discarding whatever the driver reports. */
export async function exec(db: Database | SpaceDb, statement: SQL): Promise<void> {
  await db.run(statement);
}

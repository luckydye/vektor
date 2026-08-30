/**
 * A once-per-database migration runner. A database records the highest
 * migration it has applied, so an already-migrated one opens without any DDL.
 */

import { sql } from "drizzle-orm";
import type { Database } from "./connection.ts";
import { exec, many } from "./query.ts";

export type Migration = {
  /** Permanent and monotonic: never reused, never reordered. */
  id: number;
  name: string;
  up: (db: Database) => Promise<void>;
};

const MIGRATION_TABLE = "schema_migration";

const CREATE_MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/**
 * The highest migration applied, or null when the database has never been
 * migrated. Probed with the SELECT so the warm path costs one round trip.
 */
async function appliedVersion(db: Database): Promise<number | null> {
  try {
    const rows = await many<{ version: number | null }>(
      db,
      sql.raw(`SELECT max(id) AS version FROM ${MIGRATION_TABLE}`),
    );
    return rows[0]?.version ?? 0;
  } catch {
    return null;
  }
}

/** Migrations this database has not applied yet, in the order they must run. */
function pendingSince(migrations: Migration[], version: number): Migration[] {
  const ordered = [...migrations].sort((a, b) => a.id - b.id);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].id === ordered[index - 1].id) {
      throw new Error(`Duplicate migration id: ${ordered[index].id}`);
    }
  }
  return ordered.filter((migration) => migration.id > version);
}

/**
 * Apply every migration this database is missing, and return their ids. Each is
 * stamped as it succeeds, so an interrupted run resumes at the one that failed.
 */
export async function runMigrations(
  db: Database,
  migrations: Migration[],
): Promise<number[]> {
  const version = await appliedVersion(db);
  if (version === null) await exec(db, sql.raw(CREATE_MIGRATION_TABLE));

  const pending = pendingSince(migrations, version ?? 0);
  for (const migration of pending) {
    await migration.up(db);
    await exec(
      db,
      sql`INSERT OR REPLACE INTO schema_migration (id, name, applied_at) VALUES (${migration.id}, ${migration.name}, ${Date.now()})`,
    );
  }
  return pending.map((migration) => migration.id);
}

/** What `runMigrations` would apply, for reporting without touching the schema. */
export async function pendingMigrations(
  db: Database,
  migrations: Migration[],
): Promise<Migration[]> {
  return pendingSince(migrations, (await appliedVersion(db)) ?? 0);
}

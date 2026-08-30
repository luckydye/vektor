/**
 * A once-per-database migration runner. A database records the highest
 * migration it has applied, so an already-migrated one opens without any DDL.
 */

import { sql } from "drizzle-orm";
import { type Database, supportsTransactions } from "./connection.ts";
import { exec, many, one } from "./query.ts";
import type { SpaceDb } from "./store.ts";

export type Migration = {
  /** Permanent and monotonic: never reused, never reordered. */
  id: number;
  name: string;
  /**
   * Takes the transaction-scoped handle where the driver has one, so a failure
   * rolls the whole step back rather than leaving half of it applied.
   */
  up: (db: SpaceDb) => Promise<void>;
};

const MIGRATION_TABLE = "schema_migration";
const LOCK_TABLE = "schema_migration_lock";

const CREATE_MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

const CREATE_LOCK_TABLE = `CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
  id INTEGER PRIMARY KEY,
  holder TEXT,
  acquired_at INTEGER NOT NULL
)`;

/**
 * How long a claim stays valid. A process killed mid-migration cannot release
 * its claim, so one has to expire — long enough that a slow migration is never
 * mistaken for a dead process.
 */
const LOCK_TTL_MS = 10 * 60 * 1000;

/** How long to wait for another process's migration before giving up. */
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;

/**
 * Whether the error is the migration table not existing yet.
 *
 * Matched on rather than assumed: a network or auth failure against a hosted
 * database reads as "no version" otherwise, and the runner would replay every
 * migration from the first against a live database.
 */
function isMissingMigrationTable(error: unknown): boolean {
  // Down the cause chain: drizzle reports "Failed query: …" and hangs the
  // driver's own error, which carries the reason, off `cause`.
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes(`no such table: ${MIGRATION_TABLE}`) ||
      message.includes(`no such table: main.${MIGRATION_TABLE}`)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

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
  } catch (error) {
    if (isMissingMigrationTable(error)) return null;
    throw error;
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
 * Claim the right to migrate this database, or null if someone else holds it.
 *
 * A compare-and-swap on one row, verified by reading the holder back: the
 * driver's `rowsAffected` is not in the shape `exec` exposes, and the read-back
 * is the same round trip either way. Two processes both write; the second finds
 * the row already claimed, so exactly one reads its own token back.
 */
async function claimMigrationLock(db: Database): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = Date.now();

  await exec(
    db,
    sql`UPDATE schema_migration_lock SET holder = ${token}, acquired_at = ${now}
        WHERE id = 1 AND (holder IS NULL OR acquired_at <= ${now - LOCK_TTL_MS})`,
  );

  const held = await one(
    many<{ holder: string | null }>(
      db,
      sql.raw(`SELECT holder FROM ${LOCK_TABLE} WHERE id = 1`),
    ),
  );
  return held?.holder === token ? token : null;
}

async function releaseMigrationLock(db: Database, token: string): Promise<void> {
  await exec(
    db,
    sql`UPDATE schema_migration_lock SET holder = NULL, acquired_at = 0 WHERE id = 1 AND holder = ${token}`,
  );
}

/**
 * Hold the migration lock for the length of `work`.
 *
 * Waits rather than failing fast: the other holder is a peer process or the
 * migrate CLI, and what this caller wants is a migrated database, not to run
 * the migrations itself. It gives up loudly instead of proceeding unserialized.
 */
async function withMigrationLock<T>(db: Database, work: () => Promise<T>): Promise<T> {
  await exec(db, sql.raw(CREATE_LOCK_TABLE));
  await exec(
    db,
    sql.raw(
      `INSERT OR IGNORE INTO ${LOCK_TABLE} (id, holder, acquired_at) VALUES (1, NULL, 0)`,
    ),
  );

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const token = await claimMigrationLock(db);
    if (token) {
      try {
        return await work();
      } finally {
        await releaseMigrationLock(db, token).catch(() => {
          // The claim expires on its own; failing here would mask the outcome
          // of the migration itself.
        });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Another process is migrating this database and did not finish in time",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Apply one migration and stamp it, as one unit where the driver has them. */
async function applyMigration(db: Database, migration: Migration): Promise<void> {
  const stamp = (target: SpaceDb) =>
    exec(
      target,
      sql`INSERT OR REPLACE INTO schema_migration (id, name, applied_at) VALUES (${migration.id}, ${migration.name}, ${Date.now()})`,
    );

  // An in-memory database cannot open a transaction — dev and test only, where
  // an interrupted migration is a database nobody keeps.
  if (!supportsTransactions(db)) {
    await migration.up(db);
    await stamp(db);
    return;
  }

  await db.transaction(async (tx) => {
    await migration.up(tx);
    await stamp(tx);
  });
}

/**
 * Apply every migration this database is missing, and return their ids.
 *
 * Serialized across processes: two servers opening the same space, or the
 * migrate CLI racing a live one, would otherwise both run the pending set. The
 * lock is taken only when there is something to apply, so the warm path stays
 * at the single version read.
 */
export async function runMigrations(
  db: Database,
  migrations: Migration[],
): Promise<number[]> {
  const version = await appliedVersion(db);
  if (pendingSince(migrations, version ?? 0).length === 0) return [];

  if (version === null) await exec(db, sql.raw(CREATE_MIGRATION_TABLE));

  return withMigrationLock(db, async () => {
    // Re-read under the lock: whoever held it before may have applied some or
    // all of the pending set while this caller was waiting.
    const applied: number[] = [];
    for (const migration of pendingSince(migrations, (await appliedVersion(db)) ?? 0)) {
      await applyMigration(db, migration);
      applied.push(migration.id);
    }
    return applied;
  });
}

/** What `runMigrations` would apply, for reporting without touching the schema. */
export async function pendingMigrations(
  db: Database,
  migrations: Migration[],
): Promise<Migration[]> {
  return pendingSince(migrations, (await appliedVersion(db)) ?? 0);
}

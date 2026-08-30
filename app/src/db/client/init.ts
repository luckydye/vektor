import { sql } from "drizzle-orm";
import * as authSchema from "#db/schema/auth.ts";
import type { Database } from "./connection.ts";
import { spaceMigrations } from "./migrations.ts";
import { runMigrations } from "./migrator.ts";
import { exec } from "./query.ts";
import {
  addColumnIfMissing,
  generateCreateTableSQL,
  renameColumnIfNeeded,
} from "./schemaUtils.ts";

export async function prepareAuthDb(authDb: Database) {
  const userSQL = generateCreateTableSQL(authSchema.user);
  const sessionSQL = generateCreateTableSQL(authSchema.session);
  const accountSQL = generateCreateTableSQL(authSchema.account);
  const verificationSQL = generateCreateTableSQL(authSchema.verification);
  const spaceIndexSQL = generateCreateTableSQL(authSchema.spaceIndex);

  await exec(authDb, sql.raw(userSQL));
  await exec(authDb, sql.raw(sessionSQL));
  await exec(authDb, sql.raw(accountSQL));
  await exec(authDb, sql.raw(verificationSQL));
  await exec(authDb, sql.raw(spaceIndexSQL));
  await renameColumnIfNeeded(authDb, authSchema.spaceIndex.location, "database_url");
  await addColumnIfMissing(authDb, authSchema.spaceIndex.authTokenCiphertext);
  await addColumnIfMissing(authDb, authSchema.spaceIndex.authTokenIv);
  await addColumnIfMissing(authDb, authSchema.spaceIndex.authTokenAuthTag);
  await exec(
    authDb,
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS space_index_active_slug_unique ON space_index (slug) WHERE status = 'active'",
    ),
  );
}

export async function applySpaceDbPragmas(spaceDb: Database) {
  // WAL mode: concurrent reads don't block writes, and writes batch into the
  // WAL file without per-transaction fsyncs (synchronous=NORMAL handles this).
  await exec(spaceDb, sql.raw("PRAGMA journal_mode = WAL"));
  await exec(spaceDb, sql.raw("PRAGMA synchronous = NORMAL"));
  // Keeps the WAL file small; auto-checkpoint at 1000 pages (default).
  await exec(spaceDb, sql.raw("PRAGMA wal_autocheckpoint = 1000"));
}

/**
 * Ready a freshly opened space connection, and return the migrations it needed.
 * Pragmas are connection state; the schema costs one version read when current.
 */
export async function initSpaceDbSchema(
  spaceDb: Database,
  options: { local: boolean },
): Promise<number[]> {
  await exec(spaceDb, sql.raw("PRAGMA foreign_keys = ON"));
  // The integrity pragma above is needed for every SQLite connection; these
  // remaining pragmas tune durable local files only.
  if (options.local) await applySpaceDbPragmas(spaceDb);

  return runMigrations(spaceDb, spaceMigrations);
}

import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";

import * as authSchema from "./schema/auth.ts";
import * as spaceSchema from "./schema/space.ts";
import { generateCreateTableSQL } from "./schemaUtils.ts";

const DATA_DIR = "./data";

export async function getExistingColumnNames(db: BunSQLiteDatabase, tableName: string) {
  const rows = await db.all<{ name: string }>(
    sql.raw(`SELECT name FROM pragma_table_info('${tableName}')`),
  );
  return new Set(rows.map(({ name }) => name));
}

export async function ensureColumnExists(
  db: BunSQLiteDatabase,
  tableName: string,
  columnName: string,
  columnDefinition: string,
) {
  const existingColumns = await getExistingColumnNames(db, tableName);
  if (existingColumns.has(columnName)) {
    return;
  }

  await db.run(
    sql.raw(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`),
  );
}

export async function prepateAuthDb(authDb: BunSQLiteDatabase) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Generate CREATE TABLE statements from Drizzle schemas
  const userSQL = generateCreateTableSQL(authSchema.user);
  const sessionSQL = generateCreateTableSQL(authSchema.session);
  const accountSQL = generateCreateTableSQL(authSchema.account);
  const verificationSQL = generateCreateTableSQL(authSchema.verification);

  // Execute table creation
  await authDb.run(sql.raw(userSQL));
  await authDb.run(sql.raw(sessionSQL));
  await authDb.run(sql.raw(accountSQL));
  await authDb.run(sql.raw(verificationSQL));

  // Auth database initialized
}

/**
 * Run all DDL migrations on a space database instance.
 * Works for both file-backed and in-memory SQLite databases.
 */
export async function initSpaceDbSchema(spaceDb: BunSQLiteDatabase) {
  const metadataSQL = generateCreateTableSQL(spaceSchema.spaceMetadata);
  const documentSQL = generateCreateTableSQL(spaceSchema.document);
  const revisionSQL = generateCreateTableSQL(spaceSchema.revision);
  const propertySQL = generateCreateTableSQL(spaceSchema.property);
  const categorySQL = generateCreateTableSQL(spaceSchema.category);

  await spaceDb.run(sql.raw(metadataSQL));
  await spaceDb.run(sql.raw(documentSQL));
  await spaceDb.run(sql.raw(revisionSQL));
  await spaceDb.run(sql.raw(propertySQL));
  await spaceDb.run(sql.raw(categorySQL));

  // Performance indexes — safe to add to existing DBs
  await spaceDb.run(
    sql.raw("CREATE INDEX IF NOT EXISTS document_updated_at_idx ON document (updated_at DESC)"),
  );
  await spaceDb.run(
    sql.raw("CREATE INDEX IF NOT EXISTS document_parent_id_idx ON document (parent_id)"),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS property_document_id_key_idx ON property (document_id, key)",
    ),
  );

  const preferenceSQL = generateCreateTableSQL(spaceSchema.preference);
  await spaceDb.run(sql.raw(preferenceSQL));

  const extensionSQL = generateCreateTableSQL(spaceSchema.extension);
  await spaceDb.run(sql.raw(extensionSQL));
  await spaceDb.run(sql.raw("DROP TABLE IF EXISTS extension_storage"));

  const commentsSQL = generateCreateTableSQL(spaceSchema.comment);
  await spaceDb.run(sql.raw(commentsSQL));

  const aclSQL = generateCreateTableSQL(spaceSchema.acl);
  await spaceDb.run(sql.raw(aclSQL));

  const auditLogSQL = generateCreateTableSQL(spaceSchema.auditLog);
  await spaceDb.run(sql.raw(auditLogSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS audit_log_doc_id_created_at_idx ON audit_log (doc_id, created_at DESC, id DESC)",
    ),
  );

  const accessTokenSQL = generateCreateTableSQL(spaceSchema.accessToken);
  await spaceDb.run(sql.raw(accessTokenSQL));

  const aiChatSessionSQL = generateCreateTableSQL(spaceSchema.aiChatSession);
  await spaceDb.run(sql.raw(aiChatSessionSQL));
  await ensureColumnExists(spaceDb, "ai_chat_session", "shell_snapshot", "TEXT");

  const jobScheduleSQL = generateCreateTableSQL(spaceSchema.jobSchedule);
  await spaceDb.run(sql.raw(jobScheduleSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS job_schedule_next_run_at_idx ON job_schedule (enabled, next_run_at)",
    ),
  );

  const jobRunSQL = generateCreateTableSQL(spaceSchema.jobRun);
  await spaceDb.run(sql.raw(jobRunSQL));
  await spaceDb.run(
    sql.raw("CREATE INDEX IF NOT EXISTS job_run_queued_at_idx ON job_run (queued_at)"),
  );

  const workflowRunSQL = generateCreateTableSQL(spaceSchema.workflowRun);
  await spaceDb.run(sql.raw(workflowRunSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS workflow_run_document_created_idx ON workflow_run (document_id, created_at)",
    ),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS workflow_run_created_at_idx ON workflow_run (created_at)",
    ),
  );

  const spaceSecretSQL = generateCreateTableSQL(spaceSchema.spaceSecret);
  await spaceDb.run(sql.raw(spaceSecretSQL));
  const oauthIntegrationSQL = generateCreateTableSQL(spaceSchema.oauthIntegration);
  await spaceDb.run(sql.raw(oauthIntegrationSQL));
  const oauthIntegrationStateSQL = generateCreateTableSQL(
    spaceSchema.oauthIntegrationState,
  );
  await spaceDb.run(sql.raw(oauthIntegrationStateSQL));
  await ensureColumnExists(spaceDb, "oauth_integration", "instance_url", "TEXT");
  await ensureColumnExists(spaceDb, "oauth_integration_state", "instance_url", "TEXT");
  await ensureColumnExists(spaceDb, "document", "search_text", "TEXT");
  await ensureColumnExists(spaceDb, "document", "search_embedding", "TEXT");
  await ensureColumnExists(spaceDb, "document", "search_updated_at", "INTEGER");
  await ensureColumnExists(spaceDb, "revision", "status", "TEXT");

  const fileSQL = generateCreateTableSQL(spaceSchema.file);
  await spaceDb.run(sql.raw(fileSQL));
  await ensureColumnExists(spaceDb, "file", "original_name", "TEXT");
  await ensureColumnExists(spaceDb, "file", "mime_type", "TEXT");
  await ensureColumnExists(spaceDb, "file", "url", "TEXT");
  await ensureColumnExists(spaceDb, "file", "updated_at", "INTEGER");

  await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_ai"));
  await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_ad"));
  await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_au"));
  await spaceDb.run(sql.raw("DROP TABLE IF EXISTS document_fts"));

  // Space database initialized
}

export async function prepareSpaceDb(spaceId: string) {
  const spacePath = join(DATA_DIR, "spaces", `${spaceId}.db`);
  const spaceDir = join(DATA_DIR, "spaces");

  if (!existsSync(spaceDir)) {
    mkdirSync(spaceDir, { recursive: true });
  }

  const spaceDb = drizzle({
    connection: {
      source: path.resolve(spacePath),
      create: true,
      readwrite: true,
    },
  });

  await initSpaceDbSchema(spaceDb);
}

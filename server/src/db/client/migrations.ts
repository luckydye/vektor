/**
 * The schema of a space database. The single baseline below creates the current
 * tables and indexes from `#db/schema/space.ts`; it is idempotent, so a database
 * migrated before the squash converges on it too. Append a migration for every
 * later schema change; never edit one that has shipped.
 */

import { sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as spaceSchema from "#db/schema/space.ts";
import type { Database } from "./connection.ts";
import type { Migration } from "./migrator.ts";
import { exec } from "./query.ts";
import { generateCreateTableSQL } from "./schemaUtils.ts";

export async function createTables(db: Database, tables: SQLiteTable[]): Promise<void> {
  for (const table of tables) {
    await exec(db, sql.raw(generateCreateTableSQL(table)));
  }
}

async function run(db: Database, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await exec(db, sql.raw(statement));
  }
}

async function baseline(db: Database): Promise<void> {
  await createTables(db, [
    spaceSchema.spaceMetadata,
    spaceSchema.preference,
    spaceSchema.comment,
    spaceSchema.extension,
    spaceSchema.document,
    spaceSchema.revision,
    spaceSchema.property,
    spaceSchema.category,
    spaceSchema.acl,
    spaceSchema.spaceSecret,
    spaceSchema.spaceRunner,
    spaceSchema.oauthIntegration,
    spaceSchema.oauthIntegrationState,
    spaceSchema.auditLog,
    spaceSchema.emailNotificationOutbox,
    spaceSchema.workflowSchedule,
    spaceSchema.aiChatSession,
    spaceSchema.aiWeeklyUsage,
    spaceSchema.file,
    spaceSchema.series,
    spaceSchema.seriesDirtyWindow,
  ]);

  await run(db, [
    "CREATE INDEX IF NOT EXISTS document_updated_at_idx ON document (updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS document_parent_id_idx ON document (parent_id)",
    "CREATE INDEX IF NOT EXISTS document_slug_idx ON document (slug)",
    "CREATE INDEX IF NOT EXISTS document_workflow_run_parent_created_idx ON document (parent_id, created_at DESC) WHERE type = 'workflow-run'",
    "CREATE INDEX IF NOT EXISTS document_live_updated_idx ON document (updated_at DESC, id) WHERE CAST(archived AS INTEGER) = 0",
    "CREATE INDEX IF NOT EXISTS document_live_type_updated_idx ON document ((lower(coalesce(nullif(type, ''), 'document'))), updated_at DESC, id) WHERE CAST(archived AS INTEGER) = 0",
    "CREATE UNIQUE INDEX IF NOT EXISTS revision_document_id_rev_unique ON revision (document_id, rev)",
    "CREATE UNIQUE INDEX IF NOT EXISTS property_document_id_key_unique ON property (document_id, key)",
    "CREATE INDEX IF NOT EXISTS property_key_value_idx ON property (key, value)",
    "CREATE INDEX IF NOT EXISTS property_key_type_idx ON property (key, type)",
    "CREATE INDEX IF NOT EXISTS audit_log_doc_id_created_at_idx ON audit_log (doc_id, created_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC, id DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS email_notification_outbox_event_recipient_unique ON email_notification_outbox (kind, source_id, recipient_user_id)",
    "CREATE INDEX IF NOT EXISTS email_notification_outbox_due_idx ON email_notification_outbox (status, available_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS workflow_schedule_source_property_unique ON workflow_schedule (source_document_id, property_key)",
    "CREATE INDEX IF NOT EXISTS workflow_schedule_next_run_at_idx ON workflow_schedule (enabled, next_run_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS space_secret_name_unique ON space_secret (name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS runner_name_unique ON runner (name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS oauth_integration_provider_user_unique ON oauth_integration (provider, user_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS oauth_integration_state_unique ON oauth_integration_state (state)",
    "CREATE UNIQUE INDEX IF NOT EXISTS series_name_unique ON series (name)",
    "CREATE INDEX IF NOT EXISTS series_document_id_idx ON series (document_id)",
  ]);
}

export const spaceMigrations: Migration[] = [{ id: 23, name: "baseline", up: baseline }];

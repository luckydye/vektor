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
import { exec, many } from "./query.ts";
import { addColumnIfMissing, columnExists, generateCreateTableSQL } from "./schemaUtils.ts";

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
    spaceSchema.chatSession,
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

async function tableExists(db: Database, table: string): Promise<boolean> {
  try {
    await exec(db, sql.raw(`SELECT 1 FROM ${table} LIMIT 0`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Private AI chats become persistent bots: `ai_chat_session` is renamed to
 * `chat_session`, its transcripts move to the `chat_message` log, and every
 * existing session is dropped rather than converted.
 */
async function chatSessions(db: Database): Promise<void> {
  if (await tableExists(db, "ai_chat_session")) {
    // A database from before the squash also got an empty `chat_session` from the baseline.
    if (await tableExists(db, "chat_session")) {
      const [row] = await many<{ count: number }>(
        db,
        sql.raw("SELECT count(*) AS count FROM chat_session"),
      );
      if (Number(row?.count) > 0) {
        throw new Error("Both ai_chat_session and a non-empty chat_session exist");
      }
      await run(db, ["DROP TABLE chat_session"]);
    }
    await run(db, ["ALTER TABLE ai_chat_session RENAME TO chat_session"]);
  }

  await run(db, ["DELETE FROM chat_session"]);
  for (const column of ["messages", "conversation_history", "last_message_role"]) {
    if (await columnExists(db, "chat_session", column)) {
      await run(db, [`ALTER TABLE chat_session DROP COLUMN ${column}`]);
    }
  }

  const { chatSession, workflowSchedule } = spaceSchema;
  for (const column of [
    chatSession.shellSnapshot,
    chatSession.source,
    chatSession.node,
    chatSession.visibility,
    chatSession.access,
    chatSession.rolePrompt,
    chatSession.avatar,
    chatSession.memory,
    chatSession.memoryThroughSeq,
    chatSession.repliedThroughSeq,
    chatSession.parentSessionId,
    chatSession.threadRootSeq,
    chatSession.nodeAgent,
    workflowSchedule.sessionId,
  ]) {
    await addColumnIfMissing(db, column);
  }

  await run(db, [
    `CREATE TABLE IF NOT EXISTS chat_message (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      author_id TEXT,
      content TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS chat_message_session_seq_idx ON chat_message (session_id, seq)",
    "CREATE INDEX IF NOT EXISTS chat_session_parent_idx ON chat_session (parent_session_id)",
  ]);
}

async function managedBots(db: Database): Promise<void> {
  await addColumnIfMissing(db, spaceSchema.chatSession.managedBy);
  await run(db, [
    "CREATE INDEX IF NOT EXISTS chat_session_managed_by_idx ON chat_session (managed_by)",
  ]);
}

export const spaceMigrations: Migration[] = [
  { id: 23, name: "baseline", up: baseline },
  { id: 24, name: "chat sessions", up: chatSessions },
  { id: 25, name: "managed bots", up: managedBots },
];
